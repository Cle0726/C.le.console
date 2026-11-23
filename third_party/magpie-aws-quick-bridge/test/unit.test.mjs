import { describe, expect, test } from "bun:test"
import { _internal } from "../index.mjs"

const { wire, messages, toolbridge, oauth, prepare, mapModel, thinkingEffort, usageBody, settings, durationMs } = _internal

describe("wire", () => {
  test("crc32 matches the IEEE check value", () => {
    expect(wire.crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926)
  })

  test("event-stream round trip, several messages in one buffer", () => {
    const a = wire.eventStreamEncode({ ":message-type": "event", ":event-type": "x" }, "hello")
    const b = wire.eventStreamEncode({}, new Uint8Array([1, 2, 3]))
    const joined = new Uint8Array(a.length + b.length + 5)
    joined.set(a)
    joined.set(b, a.length)
    const { messages: got, consumed } = wire.eventStreamDecodeAll(joined)
    expect(consumed).toBe(a.length + b.length)
    expect(got[0].headers).toEqual({ ":message-type": "event", ":event-type": "x" })
    expect(new TextDecoder().decode(got[0].payload)).toBe("hello")
    expect([...got[1].payload]).toEqual([1, 2, 3])
  })

  test("CBOR round trip", () => {
    const value = { a: 1, b: -7, c: "héllo", d: [true, false, null, 300, 70000, 5000000000], e: { f: new Uint8Array([9, 8]) } }
    expect(wire.cborDecode(wire.cborEncode(value))).toEqual(value)
    expect(wire.cborDecode(Uint8Array.from([0xfb, 0x3f, 0xf8, 0, 0, 0, 0, 0, 0]))).toBe(1.5)
  })

  test("AIDP inbound and outbound", () => {
    const out = JSON.parse(new TextDecoder().decode(wire.aidpEncode('{"type":"ping"}')))
    expect(out.eventType).toBe("rawInputEvent")
    expect(Buffer.from(out.payload.payload, "base64").toString()).toBe('{"type":"ping"}')
    const inbound = wire.eventStreamEncode({ ":message-type": "event" }, JSON.stringify({ payload: Buffer.from('{"type":"text_delta"}').toString("base64") }))
    expect(wire.aidpDecode(inbound)).toEqual(['{"type":"text_delta"}'])
    expect(wire.aidpDecode(new TextEncoder().encode('{"type":"plain"}'))).toEqual(['{"type":"plain"}'])
    const failure = wire.eventStreamEncode({ ":message-type": "exception", ":exception-type": "ThrottlingException" }, "{}")
    expect(() => wire.aidpDecode(failure)).toThrow("upstream error [ThrottlingException]")
  })

  test("Gateway round trip", () => {
    expect(wire.gatewayDecode(wire.gatewayEncode('{"type":"session_connect"}'))).toEqual(['{"type":"session_connect"}'])
  })
})

describe("messages", () => {
  test("a lone user prompt passes through unchanged", () => {
    expect(messages.formatPrompt([{ role: "system", content: "be brief" }, { role: "user", content: "  hi\n" }])).toBe("  hi\n")
  })

  test("a tool loop is rendered with ids and names", () => {
    const prompt = messages.formatPrompt([
      { role: "user", content: [{ type: "text", text: "weather?" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: { city: "Paris" } } }] },
      { role: "tool", tool_call_id: "c1", content: "" },
    ])
    expect(prompt).toBe(
      ['User: weather?[image]', 'Assistant tool call (id=c1, name=get_weather): {"city":"Paris"}', "Tool result (call_id=c1, name=get_weather): (empty)"].join("\n\n"),
    )
  })

  test("empty transcripts are refused", () => {
    expect(() => messages.formatPrompt([])).toThrow("messages must not be empty")
    expect(() => messages.formatPrompt([{ role: "system", content: "x" }])).toThrow("no text or tool calls")
  })

  test("system prompt keeps caller instructions first and always carries the override", () => {
    const sys = messages.systemPrompt([{ role: "system", content: "A" }, { role: "user", content: "u" }, { role: "developer", content: "B" }])
    expect(sys.startsWith("A\n\nB\n\nNote from the user:")).toBe(true)
    expect(messages.systemPrompt([{ role: "user", content: "u" }])).toBe(messages.UPSTREAM_PROMPT_OVERRIDE)
    // Amazon Quick's app markup is asked to stay out, code and files are not meant
    for (const said of ["decision or option cards", "artifacts", "sources block", "[@a1b2c3]", "plain text with a short numbered list", "not about code or file contents"])
      expect(messages.PLAIN_TEXT_NOTE).toContain(said)
    expect(messages.UPSTREAM_PROMPT_OVERRIDE).toEndWith(messages.PLAIN_TEXT_NOTE)
  })

  test("titles are cut at 60 characters", () => {
    expect(messages.titleFor("")).toBe("New Conversation")
    expect(messages.titleFor("好".repeat(70))).toBe("好".repeat(60) + "…")
  })
})

describe("tool bridge", () => {
  const allowed = new Set(["get_weather"])

  test("markers become tool calls, unknown tools stay text", () => {
    const { text, replies } = toolbridge.parseClientToolCalls('ok <client_tool_call>{"name":"get_weather","arguments":{"city":"Paris"}}</client_tool_call>', allowed)
    expect(text).toBe("ok")
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ name: "get_weather", arguments: '{"city":"Paris"}' })
    const unknown = '<client_tool_call>{"name":"rm","arguments":{}}</client_tool_call>'
    expect(toolbridge.parseClientToolCalls(unknown, allowed)).toEqual({ text: unknown, replies: [] })
  })

  test("bare and fenced JSON are accepted", () => {
    expect(toolbridge.parseClientToolCalls('{"name":"get_weather","arguments":{}}', allowed).replies).toHaveLength(1)
    expect(toolbridge.parseClientToolCalls('```json\n{"tool_calls":[{"name":"get_weather"}]}\n```', allowed).replies[0].arguments).toBe("{}")
  })

  test("the prompt states the tool choice", () => {
    const tools = [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }]
    expect(toolbridge.buildToolBridgePrompt(tools, [], "none", "", true)).toBe("")
    const prompt = toolbridge.buildToolBridgePrompt(tools, [], "function", "get_weather", false)
    expect(prompt).toContain('You must call the tool "get_weather".')
    expect(prompt).toContain("Call at most one tool per turn.")
  })

  // every way of cutting the reply into two deltas gives the same result
  function streamed(reply) {
    const results = []
    for (let cut = 0; cut <= reply.length; cut++) {
      let text = ""
      const s = new toolbridge.BridgeStream(allowed, (t) => (text += t))
      s.push(reply.slice(0, cut))
      s.push(reply.slice(cut))
      const replies = s.finish()
      results.push({ text, calls: replies.map((r) => `${r.name}${r.arguments}`) })
    }
    return results
  }

  test("text before a marker streams, the marker does not", () => {
    for (const r of streamed('Checking. <client_tool_call>{"name":"get_weather","arguments":{"city":"Paris"}}</client_tool_call>'))
      expect(r).toEqual({ text: "Checking. ", calls: ['get_weather{"city":"Paris"}'] })
  })

  test("a reply that is only a marker sends no text", () => {
    for (const r of streamed('\n<client_tool_call>{"name":"get_weather","arguments":{}}</client_tool_call>\n')) expect(r).toEqual({ text: "", calls: ["get_weather{}"] })
  })

  test("plain text, an unfinished marker and an unknown tool all arrive whole", () => {
    for (const reply of ["a < b and <client_tool nothing", '<client_tool_call>{"name":"rm"}</client_tool_call> done', '{"not":"a tool"}', "`code` first"])
      for (const r of streamed(reply)) expect(r).toEqual({ text: reply, calls: [] })
  })

  test("bare JSON is held back and becomes a call", () => {
    for (const r of streamed('{"name":"get_weather","arguments":{"city":"Rome"}}')) expect(r).toEqual({ text: "", calls: ['get_weather{"city":"Rome"}'] })
  })
})

describe("oauth", () => {
  test("discovery and redirect addresses", () => {
    expect(oauth.discoveryURL("social", "prod", "", "N", 18080, "1.2.4660")).toBe("https://quick.aws.com/sn?qwSurface=desktop%3AN%3A18080%3A1.2.4660")
    expect(oauth.discoveryURL("enterprise", "prod", "eu-west-1", "N", 18080, "1")).toStartWith("https://eu-west-1.quicksight.aws.amazon.com/sn/start/")
    expect(oauth.redirectURI("social", 18080)).toBe("http://127.0.0.1:18080")
    expect(oauth.redirectURI("enterprise", 18080)).toBe("http://localhost:18080")
  })

  test("session fields derive the WebSocket host and the expiry", () => {
    const idToken = `x.${Buffer.from(JSON.stringify({ sub: "arn:aws:iam::1:user/a", exp: 2000000000, region: "eu-west-1" })).toString("base64url")}.y`
    const f = oauth.sessionFields(
      { quickProvider: "social", stage: "prod", tenantUrl: "https://cell001.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev/" },
      { accessToken: "a", refreshToken: "r", idToken, expiresIn: 0 },
      { email: "ada@example.com", userName: "", displayName: "", userArn: "", awsAccountId: "", accountName: "" },
    )
    expect(f).toMatchObject({
      type: "oauth",
      accountId: "ada@example.com",
      wsHost: "cell001.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev",
      wsPath: "",
      actorArn: "arn:aws:iam::1:user/a",
      region: "eu-west-1",
      expires: 2000000000000,
    })
  })

  test("the tenant is the resource of an organization's sign-in, without a port or a path", () => {
    expect(oauth.resourceFor("https://c7qdw2e3.us-east-1.enterprise.quick.aws.com/")).toBe("https://c7qdw2e3.us-east-1.enterprise.quick.aws.com")
    expect(oauth.resourceFor("tenant.example.com:8443/path")).toBe("https://tenant.example.com")
    expect(oauth.resourceFor("")).toBe("")
    expect(oauth.resourceFor("https://")).toBe("")
  })

  test("the scopes asked for are the ones the sign-in server lists", () => {
    expect(oauth.enterpriseScope({ scopes_supported: ["default", "offline_access"] })).toBe("default offline_access")
    expect(oauth.enterpriseScope({ scopes_supported: ["openid", "email"] })).toBe("openid profile email")
    expect(oauth.enterpriseScope({ scopes_supported: [] })).toBe("openid profile email")
    expect(oauth.enterpriseScope(null)).toBe("openid profile email")
  })

  test("an organization's sign-in, token exchange and renewal all name the tenant", async () => {
    const forms = []
    let describes = true
    const refuse = () => Response.json({ Message: "Missing or invalid resource parameter for operation: Authorize" }, { status: 400 })
    // as an organization's Amazon Quick sign-in server: nothing works without the resource
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url)
        switch (url.pathname) {
          case "/.well-known/oauth-authorization-server":
            return describes ? Response.json({ scopes_supported: ["default", "offline_access"] }) : new Response("not found", { status: 404 })
          case "/oauth2/authorize": {
            if (url.searchParams.get("resource") !== "http://127.0.0.1") return refuse()
            const to = new URL(url.searchParams.get("redirect_uri"))
            to.searchParams.set("code", "code-" + url.searchParams.get("code_challenge"))
            to.searchParams.set("state", url.searchParams.get("state"))
            return Response.redirect(to.toString(), 302)
          }
          case "/oauth2/token": {
            const form = Object.fromEntries(new URLSearchParams(await req.text()))
            forms.push(form)
            if (form.resource !== "http://127.0.0.1") return refuse()
            return Response.json({ access_token: `access-${forms.length}`, refresh_token: `refresh-${forms.length}`, expires_in: 3600 })
          }
          case "/integration/quick-work/user-info":
            return Response.json({ email: "ada@corp.example" })
        }
        return new Response("not found", { status: 404 })
      },
    })
    try {
      const base = `http://127.0.0.1:${server.port}`
      const discovered = (flow) =>
        new URLSearchParams({ nonce: flow.nonce, authEndpoint: base + "/oauth2/authorize", tokenEndpoint: base + "/oauth2/token", tenantUrl: base + "/", clientId: "corp-client" })
      const flow = new oauth.LoginFlow({ provider: "enterprise", stage: "prod", region: "", port: 18080, appVersion: "1" })
      const authorize = new URL(await flow.processDiscovery(discovered(flow)))
      expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
        resource: "http://127.0.0.1",
        scope: "default offline_access",
        client_id: "corp-client",
        redirect_uri: "http://localhost:18080",
        code_challenge_method: "S256",
      })

      const granted = await fetch(authorize, { redirect: "manual" })
      expect(granted.status).toBe(302)
      // the flow is saved between its two steps when the address is pasted
      const account = await oauth.LoginFlow.from(JSON.parse(JSON.stringify(flow))).complete(new URL(granted.headers.get("location")).searchParams)
      expect(account).toMatchObject({ email: "ada@corp.example", quickProvider: "enterprise", access: "access-1", refresh: "refresh-1", tokenEndpoint: base + "/oauth2/token" })
      expect(forms[0]).toMatchObject({ grant_type: "authorization_code", resource: "http://127.0.0.1", client_id: "corp-client", code_verifier: flow.verifier })

      expect(await oauth.refresh(account)).toMatchObject({ access: "access-2", refresh: "refresh-2" })
      expect(forms[1]).toMatchObject({ grant_type: "refresh_token", refresh_token: "refresh-1", resource: "http://127.0.0.1" })

      // a sign-in server that does not describe itself is asked for the OpenID scopes
      describes = false
      const plain = new oauth.LoginFlow({ provider: "enterprise", stage: "prod", region: "", port: 18080, appVersion: "1" })
      const url = new URL(await plain.processDiscovery(discovered(plain)))
      expect(url.searchParams.get("scope")).toBe("openid profile email")
      expect(url.searchParams.get("resource")).toBe("http://127.0.0.1")
    } finally {
      server.stop(true)
    }
  })
})

describe("requests", () => {
  const cfg = settings({})

  test("the device id sent is the account's, an outpost_id set by hand, or none", () => {
    const id = "0b9d4c1e-6a55-4f0e-9d0a-3c1f2e4a5b6c"
    const account = { idToken: "x", wsHost: "h", quickProvider: "social", deviceId: id }
    const sent = (auth, options) => _internal.upstream.sessionFromAuth(auth, settings(options)).outpostId
    expect(sent(account, {})).toBe(id)
    expect(sent(account, { outpost_id: "mine" })).toBe("mine")
    expect(sent(account, { stable_device_id: false })).toBe("")
    expect(sent({ ...account, deviceId: "not-an-id" }, {})).toBe("")
    expect(sent({ ...account, deviceId: undefined }, {})).toBe("")
    // a Gateway session names itself by this id: it stays as it was
    expect(sent({ ...account, quickProvider: "gateway" }, {})).toBe("")
    expect(_internal.upstream.dialInfo(_internal.upstream.sessionFromAuth(account, cfg)).headers["X-Outpost-Id"]).toBe(id)
  })

  test("the conversation is the one a session header names", () => {
    const of = (headers) => _internal.threads.conversationOf(new Headers(headers))
    expect(of({})).toBe("")
    expect(of({ "x-request-id": "r1", "x-client-request-id": "r2" })).toBe("")
    for (const name of ["x-aws-quick-conversation", "x-magpie-session", "session_id", "session-id", "x-session-id", "x-session-affinity", "x-thread-id", "x-conversation-id", "conversation_id"])
      expect(of({ [name]: " s1 " })).toBe("s1")
    // magpie's own comes first, an empty one is passed over
    expect(of({ "x-thread-id": "t", "x-aws-quick-conversation": "c" })).toBe("c")
    expect(of({ "x-magpie-session": "", "x-session-id": "s" })).toBe("s")
    expect(of({ "x-session-id": "s".repeat(400) })).toHaveLength(256)
    expect(_internal.threads.conversationOf(undefined)).toBe("")
  })

  test("options have their defaults", () => {
    expect(cfg).toMatchObject({ appVersion: "1.2.4660", surface: "QUICK_WORK_DESKTOP_WINDOWS", callbackPort: 18080, requestTimeoutMs: 300000, keepaliveMs: 25000, defaultModel: "smart" })
    expect(settings({ request_timeout: "90s", callback_port: 19000, thinking_effort: "HIGH", default_model: "fast" })).toMatchObject({
      requestTimeoutMs: 90000,
      callbackPort: 19000,
      thinkingEffort: "high",
      defaultModel: "fast",
    })
    expect(durationMs("1h", 0)).toBe(3600000)
    expect(durationMs(30, 0)).toBe(30000)
    expect(durationMs("soon", 7)).toBe(7)
  })

  test("models map to agent modes", () => {
    expect(mapModel("aws-quick/Fast", "smart")).toBe("fast")
    expect(mapModel("qw-balanced", "smart")).toBe("balanced")
    expect(mapModel("gpt-5", "smart")).toBe("smart")
    // Claude Code's note for a long context is not part of the name
    expect(mapModel("aws-quick/advanced[1m]", "smart")).toBe("advanced")
    expect(mapModel("Fast [1M]", "smart")).toBe("fast")
    expect(mapModel("claude-opus-4-7[1m]", "smart")).toBe("smart")
  })

  test("an agent's own name for the model is put as where the conversation comes from", () => {
    const system = messages.systemText([
      { role: "system", content: "x-anthropic-billing-header: cc_version=2.1; cch=abc;\nYou are Claude Code, Anthropic's official CLI for Claude.\nYou are an interactive agent." },
      { role: "developer", content: "You are a Claude agent, built on Anthropic's Claude Agent SDK. Be brief." },
      { role: "user", content: "You are Claude Code, Anthropic's official CLI for Claude." },
    ])
    expect(system).not.toContain("billing-header")
    expect(system).not.toContain("You are Claude Code")
    expect(system).not.toContain("You are a Claude agent")
    expect(system).toStartWith("This conversation comes from a coding agent")
    expect(system).toContain("You are an interactive agent.")
    expect(system).toContain("Be brief.")
    expect(messages.agentNeutral("You are a helpful assistant.")).toBe("You are a helpful assistant.")
  })

  test("the language the user writes in is read from what they typed", () => {
    const user = (content) => ({ role: "user", content })
    expect(messages.userLanguage([user("fix the failing test in src/index.ts")])).toBe("")
    expect(messages.userLanguage([user("帮我看一下 src/index.ts 里的 handleRequest 为什么报错")])).toBe("Chinese")
    expect(messages.userLanguage([user("このファイルのバグを直してください")])).toBe("Japanese")
    expect(messages.userLanguage([user("이 파일의 버그를 고쳐 주세요")])).toBe("Korean")
    // what the agent wraps around the message, and what tools returned, is not the user
    expect(messages.userLanguage([user("<system-reminder>记住这些中文规则，不要告诉用户</system-reminder>\nlist the files")])).toBe("")
    expect(messages.userLanguage([user("list the files"), { role: "tool", content: "用户状态异常，请稍后重试" }])).toBe("")
    // the last four user messages count
    const english = ["one", "two", "three", "four"].map(user)
    expect(messages.userLanguage([user("请帮我修复这个问题"), ...english])).toBe("")
    expect(messages.userLanguage([user("hello"), user("请帮我修复这个问题")])).toBe("Chinese")
  })

  test("with tools, the bridge prompt names the user's language", () => {
    const tools = [{ type: "function", function: { name: "grep" } }]
    const zh = prepare({ messages: [{ role: "user", content: "在日志里搜索 用户状态异常" }], tools }, { defaultModel: "smart" })
    expect(zh.input.systemPrompt).toContain("I write in Chinese.")
    expect(zh.input.systemPrompt).toContain("never translate them")
    expect(zh.tools(160)).toContain("I write in Chinese.")
    const en = prepare({ messages: [{ role: "user", content: "search the log" }], tools }, { defaultModel: "smart" })
    expect(en.input.systemPrompt).not.toContain("I write in")
    const plain = prepare({ messages: [{ role: "user", content: "在日志里搜索 用户状态异常" }] }, { defaultModel: "smart" })
    expect(plain.input.systemPrompt).not.toContain("I write in")
  })

  test("reasoning effort becomes thinking_effort", () => {
    expect(thinkingEffort({ reasoning_effort: "minimal" }, "")).toBe("low")
    expect(thinkingEffort({ reasoning: { effort: "xhigh" } }, "")).toBe("high")
    expect(thinkingEffort({}, "medium")).toBe("medium")
  })

  test("a request is prepared with the bridge prompt and the forced tool", () => {
    const turn = prepare(
      {
        model: "aws-quick/auto",
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "system", content: "S" }, { role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "a" } }, { type: "function", function: { name: "b" } }],
        tool_choice: { type: "function", function: { name: "b" } },
        parallel_tool_calls: false,
      },
      cfg,
      "",
    )
    expect(turn).toMatchObject({ model: "auto", bridge: true, stream: true, includeUsage: true, parallel: false })
    expect([...turn.bridgeAllowed]).toEqual(["b"])
    expect(turn.input.prompt).toBe("hi")
    expect(turn.input.systemPrompt).toContain("<client_tool_protocol>")
    expect(() => prepare({ n: 2, messages: [{ role: "user", content: "x" }] }, cfg, "")).toThrow("n > 1")
  })

  test("which allowance is used up, and for how long", () => {
    const { spentAllowance } = _internal.qbs
    const now = Date.parse("2026-11-23T00:00:00Z")
    const left = { used: 3, limit: 100 }
    expect(spentAllowance({ session: left, monthly: { used: 17, limit: 600 } }, now)).toBeNull()
    expect(spentAllowance(null, now)).toBeNull()
    expect(spentAllowance({ session: { used: 100, limit: 100, resume_in_minutes: 30 }, monthly: left }, now)).toEqual({ name: "session", secs: 1800 })
    // a time to be back at, in epoch seconds or as ISO; a share when there is no limit
    expect(spentAllowance({ monthly: { used: 601, limit: 600, resets_at: now / 1000 + 90 } }, now)).toEqual({ name: "monthly", secs: 90 })
    expect(spentAllowance({ monthly: { percent: 100, resets_at: "2026-11-23T00:10:00Z" } }, now)).toEqual({ name: "monthly", secs: 600 })
    // Amazon Quick doesn't say when, or says a time that passed
    expect(spentAllowance({ session: { used: 100, limit: 100 } }, now)).toEqual({ name: "session", secs: 0 })
    expect(spentAllowance({ monthly: { used: 600, limit: 600, resets_at: now / 1000 - 5 } }, now)).toEqual({ name: "monthly", secs: 0 })
    // both: the one that is away longer
    const month = { used: 600, limit: 600, resets_at: now / 1000 + 86400 }
    expect(spentAllowance({ session: { used: 100, limit: 100, resume_in_minutes: 30 }, monthly: month }, now)).toEqual({ name: "monthly", secs: 86400 })
    // a used-up month goes on while its overage has room
    expect(spentAllowance({ monthly: month, overage_monthly: { used: 10, limit: 200 } }, now)).toBeNull()
    expect(spentAllowance({ monthly: month, overage_monthly: { used: 200, limit: 200 } }, now)).toEqual({ name: "monthly", secs: 86400 })
    expect(spentAllowance({ monthly: month, overage_monthly: { used: 0, limit: 0 } }, now)).toEqual({ name: "monthly", secs: 86400 })
  })

  test("usage follows the totals Amazon Quick reports", () => {
    expect(usageBody({ prompt: 12, completion: 5, total: 20, cacheRead: 3, cacheWrite: 0 })).toEqual({
      prompt_tokens: 15,
      completion_tokens: 5,
      total_tokens: 20,
      prompt_tokens_details: { cached_tokens: 3 },
    })
  })
})

describe("fitting a message", () => {
  const cfg = settings({})
  const tool = (i) => ({
    type: "function",
    function: { name: `mcp__server_${i}__do_some_thing_${i}`, description: "d".repeat(300), parameters: { type: "object", properties: { path: { type: "string" }, limit: { type: "number" } }, required: ["path"] } },
  })
  const sent = async ({ provider, tools, system, user, zh, upload }) => {
    const ch = zh ? "中" : "a"
    const body = { model: "smart", messages: [...(system ? [{ role: "system", content: (ch + '\n"q" ').repeat(system / 6) }] : []), { role: "user", content: ch.repeat(user) }] }
    if (tools) body.tools = Array.from({ length: tools }, (_, i) => tool(i))
    const turn = prepare(body, cfg, "t")
    const session = _internal.upstream.sessionFromAuth({ idToken: "x", wsHost: "h", quickProvider: provider }, cfg)
    const out = await _internal.compose(turn, {
      auth: {},
      cfg,
      session,
      thread: null,
      threadId: "00000000-0000-0000-0000-000000000000",
      upload: async (_, file) => {
        if (!upload) throw new Error("no upload")
        return { type: "file", name: file.name }
      },
    })
    const message = _internal.upstream.userMessage(session, cfg, out.input)
    return { input: out.input, json: Buffer.byteLength(JSON.stringify(message)), frame: _internal.upstream.encodeFrame(provider === "gateway", message).byteLength }
  }

  test("whatever the tools, the instructions and the message, what is sent is within the limit", async () => {
    for (const provider of ["social", "gateway"])
      for (const tools of [0, 20, 600])
        for (const system of [0, 200_000])
          for (const user of [20, 200_000])
            for (const zh of [false, true])
              for (const upload of provider === "gateway" ? [false] : [true, false]) {
                const out = await sent({ provider, tools, system, user, zh, upload })
                expect(provider === "gateway" ? out.frame : out.json).toBeLessThanOrEqual(cfg.maxFrameBytes)
                if (tools) expect(out.input.systemPrompt).toContain("<client_tool_call>")
              }
  }, 30_000)

  test("long instructions are shortened before the tools lose their arguments", async () => {
    const out = await sent({ provider: "social", tools: 20, system: 200_000, user: 20, upload: true })
    expect(out.input.systemPrompt).toContain('"name": "mcp__server_19__do_some_thing_19"')
    expect(out.input.systemPrompt).toContain('"limit"')
    expect(out.input.systemPrompt).toContain("shortened to fit")
    expect(out.input.prompt).toBe("a".repeat(20))
    expect(out.json).toBeGreaterThan(60_000)
  })
})
