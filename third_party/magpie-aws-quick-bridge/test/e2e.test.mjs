// The plugin end to end against a local stand-in for Amazon Quick: sign-in
// through the callback port, chat (plain, streamed, with tools), renewal and
// a refused sign-in.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import plugin, { _internal } from "../index.mjs"
import { startMock } from "./mock-upstream.mjs"

let mock
let hooks
let auth
const saved = []

beforeAll(async () => {
  mock = startMock()
  const client = { auth: { set: async ({ body }) => void saved.push(body) } }
  hooks = await plugin.server(
    { client, directory: "/tmp" },
    { oidc_base: mock.url, discovery_url: mock.url + "/sn", data_plane_url: mock.url, callback_port: 0, request_timeout: "10s", keepalive_interval: "100ms", header_wait: "300ms" },
  )
})

afterAll(() => {
  mock.stop()
  _internal.oauth.setEndpoints()
})

// Follows the sign-in the way a browser does.
async function browse(url) {
  for (let hops = 0; hops < 10; hops++) {
    const res = await fetch(url, { redirect: "manual" })
    if (res.status !== 302) return res
    url = res.headers.get("location")
  }
  throw new Error("too many redirects")
}

const post = async (body, init = {}) => {
  const { fetch: send, baseURL } = await hooks.auth.loader(async () => auth)
  return send(`${baseURL}/chat/completions`, { method: "POST", body: JSON.stringify(body), ...init })
}

async function sse(res) {
  const events = []
  for (const line of (await res.text()).split("\n")) if (line.startsWith("data: ") && line !== "data: [DONE]") events.push(JSON.parse(line.slice(6)))
  return events
}

describe("sign-in", () => {
  test("the provider is declared with Amazon Quick's four modes", async () => {
    const config = {}
    await hooks.config(config)
    expect(config.provider["aws-quick"].npm).toBe("@ai-sdk/openai-compatible")
    expect(Object.keys(config.provider["aws-quick"].models)).toEqual(["smart", "fast", "balanced", "auto"])
  })

  test("browser sign-in saves the account", async () => {
    const method = hooks.auth.methods[0]
    const started = await method.authorize({ provider: "social" })
    expect(started.method).toBe("auto")
    const port = new URL(started.url).port
    expect(started.url).toBe(`http://127.0.0.1:${port}/start?redirect_uri=${encodeURIComponent(`http://localhost:${port}/callback`)}`)
    expect(started.instructions).toContain(`${mock.url}/sn?qwSurface=desktop%3A`)

    // an address that isn't this sign-in's is told so, and the sign-in waits on
    expect((await fetch(`http://127.0.0.1:${port}/callback?nonce=wrong`)).status).toBe(400)
    expect((await fetch(`http://127.0.0.1:${port}/elsewhere`)).status).toBe(404)

    const page = await browse(started.url)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain("ada@example.com is signed in")

    auth = await started.callback()
    expect(auth).toMatchObject({
      type: "success",
      accountId: "ada@example.com",
      access: "access-0",
      refresh: "refresh-0",
      quickProvider: "social",
      clientId: "mock-client",
      wsHost: mock.url.replace("http://", "ws://"),
      actorArn: "arn:aws:quicksight:us-east-1:123456789012:user/default/ada",
      tokenEndpoint: mock.url + "/token",
    })
    expect(auth.expires).toBeGreaterThan(Date.now() + 3000_000)
    // the account's own device id, as the desktop app has one
    expect(auth.deviceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    auth = { ...auth, type: "oauth" }
  })

  test("a second sign-in ends the one left waiting", async () => {
    const method = hooks.auth.methods[0]
    const first = await method.authorize({ provider: "social" })
    const second = await method.authorize({ provider: "social" })
    expect(await first.callback()).toEqual({ type: "failed", error: "another sign-in to Amazon Quick was started" })
    const abort = new AbortController()
    const waiting = second.callback(undefined, { signal: abort.signal })
    abort.abort()
    expect((await waiting).type).toBe("failed")
  })
})

describe("chat", () => {
  test("a plain completion", async () => {
    const res = await post({ model: "aws-quick/fast", messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "ping" }] })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.choices[0]).toEqual({ index: 0, message: { role: "assistant", content: "pong from fast" }, finish_reason: "stop" })
    expect(body.usage).toEqual({ prompt_tokens: 15, completion_tokens: 5, total_tokens: 20, prompt_tokens_details: { cached_tokens: 3 } })

    const turn = mock.state.turns.at(-1)
    expect(turn).toMatchObject({ text: "ping", agent_mode: "fast", send_origin: "programmatic", appVersion: "1.2.4660", user_timezone: "UTC" })
    expect(turn.custom_prompt).toStartWith("Be brief.\n\nNote from the user:")
    // the account's device id is what the session is opened with
    expect(mock.state.dials.at(-1)).toBe(auth.deviceId)
    expect(mock.state.connects.at(-1)).toMatchObject({ outpostId: auth.deviceId, surfaceType: "QUICK_WORK_DESKTOP_WINDOWS" })
    expect(turn.outpostId).toBe(auth.deviceId)
    // Amazon Quick's app markup is asked to stay out of an agent's screen
    expect(turn.custom_prompt).toEndWith(_internal.messages.PLAIN_TEXT_NOTE)
    expect(turn.system_prompt).toBeUndefined()
    expect(turn.thinking_effort).toBeUndefined()
    // the conversation stays out of Amazon Quick's chat list and memory
    expect(turn).toMatchObject({ incognito: true, auto_routing: false, web_search_enabled: false })
  })

  test("a streamed completion", async () => {
    const res = await post({ model: "smart", stream: true, stream_options: { include_usage: true }, reasoning_effort: "high", messages: [{ role: "user", content: "ping" }] })
    expect(res.headers.get("content-type")).toStartWith("text/event-stream")
    const events = await sse(res)
    expect(events[0].choices[0].delta).toEqual({ role: "assistant" })
    expect(events.map((e) => e.choices[0]?.delta?.content ?? "").join("")).toBe("pong from smart")
    expect(events.at(-2).choices[0].finish_reason).toBe("stop")
    expect(events.at(-1)).toMatchObject({ choices: [], usage: { total_tokens: 20 } })
    expect(mock.state.turns.at(-1).thinking_effort).toBe("high")
  })

  const tools = [{ type: "function", function: { name: "get_weather", description: "Weather", parameters: { type: "object", properties: { city: { type: "string" } } } } }]

  test("a client tool call, streamed: the text arrives, the marker becomes a call", async () => {
    const events = await sse(await post({ model: "smart", stream: true, tools, messages: [{ role: "user", content: "Please use the tool get_weather" }] }))
    expect(events.map((e) => e.choices[0].delta.content ?? "").join("")).toBe("Let me check. ")
    const call = events.find((e) => e.choices[0].delta.tool_calls).choices[0].delta.tool_calls[0]
    expect(call).toMatchObject({ index: 0, type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } })
    expect(call.id).toStartWith("call_")
    expect(events.at(-1).choices[0].finish_reason).toBe("tool_calls")
    expect(mock.state.turns.at(-1).custom_prompt).toContain('"name": "get_weather"')
  })

  test("a client tool call, not streamed, and its result on the next turn", async () => {
    const first = await (await post({ model: "smart", tools, messages: [{ role: "user", content: "Please use the tool get_weather" }] })).json()
    expect(first.choices[0].finish_reason).toBe("tool_calls")
    const call = first.choices[0].message.tool_calls[0]
    expect(call.function).toEqual({ name: "get_weather", arguments: '{"city":"Paris"}' })

    await post({
      model: "smart",
      tools,
      messages: [
        { role: "user", content: "weather in Paris?" },
        { role: "assistant", content: null, tool_calls: [call] },
        { role: "tool", tool_call_id: call.id, content: "18°C" },
      ],
    })
    expect(mock.state.turns.at(-1).text).toBe(
      `User: weather in Paris?\n\nAssistant tool call (id=${call.id}, name=get_weather): {"city":"Paris"}\n\nTool result (call_id=${call.id}, name=get_weather): 18°C\n\n${_internal.toolbridge.TOOL_REMINDER}`,
    )
    // a turn without tools ends with the caller's own words
    await post({ model: "smart", messages: [{ role: "user", content: "ping" }] })
    expect(mock.state.turns.at(-1).text).toBe("ping")
  })

  test("a turn refused while an allowance is used up rests the account until it is back", async () => {
    const ask = () => post({ model: "smart", stream: true, messages: [{ role: "user", content: "ping" }] })
    mock.state.script = () => [{ type: "error", payload: { message: "request could not be served" } }]
    try {
      // Amazon Quick's words for it are not known: the account's usage says it
      mock.state.usage = { session: { used: 100, limit: 100, resume_in_minutes: 42 }, monthly: { used: 130, limit: 600, resets_at: 1796083200 } }
      let res = await ask()
      expect(res.status).toBe(429)
      expect(res.headers.get("retry-after")).toBe("2520")
      expect((await res.json()).error.message).toBe("Amazon Quick's session allowance is used up; it is back in 42 minutes (upstream error: request could not be served)")

      // an allowance away for long is asked about again after six hours
      mock.state.usage = { session: { used: 3, limit: 100 }, monthly: { used: 600, limit: 600, resets_at: Math.floor(Date.now() / 1000) + 9 * 86400 } }
      res = await ask()
      expect(res.status).toBe(429)
      expect(res.headers.get("retry-after")).toBe("21600")
      expect((await res.json()).error.message).toContain("monthly allowance is used up; it is back in 216 hours")

      // with something left, the failure is what it was
      mock.state.usage = null
      res = await ask()
      expect(res.status).toBe(502)
      expect(res.headers.get("retry-after")).toBeNull()
    } finally {
      Object.assign(mock.state, { script: null, usage: null })
    }
  })

  test("tool_choice none turns the bridge off", async () => {
    const body = await (await post({ model: "smart", tools, tool_choice: "none", messages: [{ role: "user", content: "Please use the tool get_weather" }] })).json()
    expect(body.choices[0].message).toEqual({ role: "assistant", content: "pong from smart" })
    expect(mock.state.turns.at(-1).custom_prompt).not.toContain("<client_tool_protocol>")
  })

  test("an error event before any text is a status magpie can act on", async () => {
    mock.state.script = () => [{ type: "turn_failed", payload: { message: "ThrottlingException: Too many requests" } }]
    const res = await post({ model: "smart", stream: true, messages: [{ role: "user", content: "ping" }] })
    expect(res.status).toBe(429)
    expect((await res.json()).error.message).toContain("Too many requests")
    mock.state.script = () => [{ type: "error", payload: { message: "internal failure" } }]
    expect((await post({ model: "smart", messages: [{ role: "user", content: "ping" }] })).status).toBe(502)
    mock.state.script = () => [{ type: "text_delta", payload: "half" }, { type: "stream_error", payload: { message: "cut" } }]
    const events = await sse(await post({ model: "smart", stream: true, messages: [{ role: "user", content: "ping" }] }))
    expect(events.at(-1).error.message).toContain("cut")
    mock.state.script = null
  })

  test("a reply that takes longer than Amazon Quick lets a client stay silent still arrives", async () => {
    Object.assign(mock.state, { idleMs: 400, delayMs: 1500, pings: 0 })
    try {
      const res = await post({ model: "smart", messages: [{ role: "user", content: "ping" }] })
      expect(res.status).toBe(200)
      expect((await res.json()).choices[0].message.content).toBe("pong from smart")
      expect(mock.state.pings).toBeGreaterThan(5)
    } finally {
      Object.assign(mock.state, { idleMs: 0, delayMs: 0 })
    }
  })

  test("bad requests and other paths", async () => {
    expect((await post({ model: "smart", messages: [] })).status).toBe(400)
    const { fetch: send, baseURL } = await hooks.auth.loader(async () => auth)
    expect((await send(`${baseURL}/responses`, { method: "POST", body: "{}" })).status).toBe(404)
    expect((await (await send(`${baseURL}/models`, { method: "GET" })).json()).data.map((m) => m.id)).toEqual(["smart", "fast", "balanced", "auto"])
  })

  test("auto is the smart mode with Amazon Quick's routing", async () => {
    await post({ model: "auto", messages: [{ role: "user", content: "ping" }] })
    expect(mock.state.turns.at(-1)).toMatchObject({ agent_mode: "smart", auto_routing: true })
  })

  test("thinking comes back as reasoning_content, a long event in pieces is put together", async () => {
    const long = JSON.stringify({ type: "text_delta", payload: { delta: "x".repeat(300) } })
    mock.state.script = () => [
      { type: "thinking_delta", payload: { delta: "hmm" } },
      { type: "_chunked_frame", payload: { chunk_id: "c1", chunk_index: 1, total_chunks: 2, data: long.slice(100) } },
      { type: "_chunked_frame", payload: { chunk_id: "c1", chunk_index: 0, total_chunks: 2, data: long.slice(0, 100) } },
      { type: "message_complete", payload: {} },
      { type: "turn_completed", payload: {} },
    ]
    const body = await (await post({ model: "smart", messages: [{ role: "user", content: "think" }] })).json()
    expect(body.choices[0].message).toEqual({ role: "assistant", content: "x".repeat(300), reasoning_content: "hmm" })
    const events = await sse(await post({ model: "smart", stream: true, messages: [{ role: "user", content: "think again" }] }))
    expect(events.map((e) => e.choices[0].delta.reasoning_content ?? "").join("")).toBe("hmm")
    mock.state.script = () => [{ type: "guardrail_blocked", payload: { message: "blocked by policy" } }]
    expect((await post({ model: "smart", messages: [{ role: "user", content: "bad" }] })).status).toBe(400)
    mock.state.script = null
  })

  // a turn of two model calls with Amazon Quick's own tool between them, the
  // counts as a real account reported them
  const searched = () => [
    { type: "thinking_delta", payload: { delta: "I'll look it up." } },
    { type: "tool_start", payload: { tool_name: "web_search", tool_id: "t1", arguments: {} } },
    { type: "tool_arguments", payload: { tool_name: "web_search", tool_id: "t1", arguments: { query: "Reykjavik population" } } },
    { type: "turn_usage", payload: { input_tokens: 4, output_tokens: 161, cache_read_tokens: 32732, cache_write_tokens: 36586, total_tokens: 69483 } },
    { type: "tool_result", payload: { tool_name: "web_search", tool_id: "t1", result: "…", status: "success" } },
    { type: "tool_start", payload: { tool_name: "web_search", tool_id: "t1", arguments: {} } },
    { type: "tool_start", payload: { tool_name: "read_file", tool_id: "t2", arguments: {} } },
    { type: "text_delta", payload: { delta: "139,000" } },
    { type: "turn_usage", payload: { input_tokens: 2, output_tokens: 340, cache_read_tokens: 69318, cache_write_tokens: 9981, total_tokens: 79641 } },
    { type: "message_complete", payload: {} },
    { type: "turn_completed", payload: {} },
  ]

  test("a turn of several model calls: the context is counted once, Amazon Quick's own tools are shown as they start", async () => {
    mock.state.script = searched
    const body = await (await post({ model: "smart", messages: [{ role: "user", content: "search" }] })).json()
    // what went in is the last call's (2 + 69318 + 9981), not both calls' added up
    expect(body.usage).toEqual({ prompt_tokens: 79301, completion_tokens: 501, total_tokens: 79802, prompt_tokens_details: { cached_tokens: 69318 } })
    expect(body.choices[0].message).toEqual({ role: "assistant", content: "139,000", reasoning_content: "I'll look it up.\n[Quick: web_search]\n[Quick: read_file]\n" })
    expect(body.choices[0].finish_reason).toBe("stop")

    const events = await sse(await post({ model: "smart", stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "search again" }] }))
    expect(events.map((e) => e.choices[0]?.delta?.reasoning_content ?? "").join("")).toContain("[Quick: web_search]\n")
    expect(events.at(-1).usage).toMatchObject({ prompt_tokens: 79301, total_tokens: 79802 })

    // show_quick_tools: false leaves the thinking as Amazon Quick wrote it
    const { upstream, settings } = _internal
    const cfg = { ...settings({ show_quick_tools: false }), requestTimeoutMs: 5000 }
    const input = { prompt: "search", model: "smart" }
    let thought = ""
    await upstream.chat({ session: upstream.sessionFromAuth(auth, cfg), cfg, input, onEvent: (e) => e.type === "reasoning" && (thought += e.text) })
    expect(thought).toBe("I'll look it up.")
    mock.state.script = null
  })

  test("a streamed request is answered while Amazon Quick is still silent, and what fails after that is said in the stream", async () => {
    mock.state.script = () => [{ wait: 900 }, { type: "text_delta", payload: { delta: "late" } }, { type: "message_complete", payload: {} }, { type: "turn_completed", payload: {} }]
    let at = Date.now()
    const res = await post({ model: "smart", stream: true, messages: [{ role: "user", content: "take your time" }] })
    const waited = Date.now() - at
    expect(res.status).toBe(200)
    expect(waited).toBeGreaterThanOrEqual(250)
    expect(waited).toBeLessThan(800)
    const events = await sse(res)
    expect(events[0].choices[0].delta).toEqual({ role: "assistant" })
    expect(events.map((e) => e.choices[0]?.delta?.content ?? "").join("")).toBe("late")

    // not streamed, the whole reply is waited for
    at = Date.now()
    expect((await (await post({ model: "smart", messages: [{ role: "user", content: "take your time, twice" }] })).json()).choices[0].message.content).toBe("late")
    expect(Date.now() - at).toBeGreaterThanOrEqual(850)

    mock.state.script = () => [{ wait: 600 }, { type: "error", payload: { message: "it broke" } }]
    const failed = await post({ model: "smart", stream: true, messages: [{ role: "user", content: "break late" }] })
    expect(failed.status).toBe(200)
    expect((await sse(failed)).at(-1).error.message).toContain("it broke")
    // within the wait, a failure is still a status
    mock.state.script = () => [{ wait: 100 }, { type: "error", payload: { message: "it broke" } }]
    expect((await post({ model: "smart", stream: true, messages: [{ role: "user", content: "break early" }] })).status).toBe(502)
    mock.state.script = null
  })

  const until = async (cond, ms = 2000) => {
    for (const end = Date.now() + ms; Date.now() < end && !cond(); ) await new Promise((r) => setTimeout(r, 10))
    return cond()
  }

  test("a cancelled request tells Amazon Quick to stop the turn", async () => {
    // a turn that ended by itself is not stopped
    expect(mock.state.stops).toEqual([])
    mock.state.script = () => []
    const abort = new AbortController()
    const pending = post({ model: "smart", messages: [{ role: "user", content: "ping" }] }, { signal: abort.signal })
    setTimeout(() => abort.abort(), 50)
    await expect(pending).rejects.toThrow()
    await pending.catch(() => {})
    expect(await until(() => mock.state.stops.length === 1)).toBe(true)
    expect(mock.state.stops[0]).toBe(mock.state.turns.at(-1).thread_id)

    // a reader who leaves a stream stops it too, with the text it had
    mock.state.script = () => [{ type: "text_delta", payload: { delta: "one " } }, { wait: 5000 }, { type: "text_delta", payload: { delta: "two" } }]
    const res = await post({ model: "smart", stream: true, messages: [{ role: "user", content: "a long one" }] })
    const reader = res.body.getReader()
    await reader.read()
    await reader.cancel()
    expect(await until(() => mock.state.stops.length === 2)).toBe(true)
    expect(mock.state.stops[1]).toBe(mock.state.turns.at(-1).thread_id)
    mock.state.script = null
  })

  test("a turn that runs out of time is stopped as well", async () => {
    mock.state.script = () => []
    const { upstream, settings } = _internal
    const cfg = { ...settings({}), requestTimeoutMs: 150 }
    const before = mock.state.stops.length
    await expect(upstream.chat({ session: upstream.sessionFromAuth(auth, cfg), cfg, input: { prompt: "never answered", model: "smart" } })).rejects.toMatchObject({ kind: "timeout" })
    expect(await until(() => mock.state.stops.length === before + 1)).toBe(true)
    mock.state.script = null
  })
})

describe("a conversation over several requests", () => {
  const tools = [{ type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }]
  const system = { role: "system", content: "You are a coding agent." }
  const ask = { role: "user", content: "Please use the tool read_file" }
  const headers = { "x-aws-quick-conversation": "s1" }

  test("the next request goes to the same thread with only what is new", async () => {
    const first = await (await post({ model: "smart", tools, messages: [system, ask] }, { headers })).json()
    const call = first.choices[0].message.tool_calls[0]
    const one = mock.state.turns.at(-1)
    expect(one.custom_prompt).toContain("<client_tool_protocol>")

    const messages = [system, ask, first.choices[0].message, { role: "tool", tool_call_id: call.id, content: "# Title" }]
    await post({ model: "smart", tools, messages }, { headers })
    const two = mock.state.turns.at(-1)
    expect(two.thread_id).toBe(one.thread_id)
    expect(two.text).toBe(`Tool result (call_id=${call.id}, name=read_file): # Title\n\n${_internal.toolbridge.TOOL_REMINDER}`)
    // the thread keeps its instructions: they are not sent again
    expect(two.custom_prompt).toBeNull()

    // changed instructions are sent again, to the same thread
    await post({ model: "smart", tools, messages: [{ role: "system", content: "Now be terse." }, ...messages.slice(1), { role: "assistant", content: "ok" }, { role: "user", content: "more" }] }, { headers })
    const three = mock.state.turns.at(-1)
    expect(three).toMatchObject({ thread_id: one.thread_id, text: `more\n\n${_internal.toolbridge.TOOL_REMINDER}` })
    expect(three.custom_prompt).toStartWith("Now be terse.")
  })

  test("another conversation, or an edited history, starts a new thread", async () => {
    const before = mock.state.turns.at(-1).thread_id
    await post({ model: "smart", messages: [system, ask, { role: "assistant", content: "x" }, { role: "user", content: "more" }] }, { headers: { "x-aws-quick-conversation": "s2" } })
    expect(mock.state.turns.at(-1).thread_id).not.toBe(before)
    await post({ model: "smart", messages: [system, { role: "user", content: "something else" }, { role: "assistant", content: "x" }, { role: "user", content: "more" }] }, { headers })
    const turn = mock.state.turns.at(-1)
    expect(turn.thread_id).not.toBe(before)
    expect(turn.text).toBe("User: something else\n\nAssistant: x\n\nUser: more")
  })

  test("a client's own session header keeps its conversations apart", async () => {
    const hi = { role: "user", content: "the same opening line" }
    const next = [hi, { role: "assistant", content: "x" }, { role: "user", content: "and then" }]
    await post({ model: "smart", messages: [hi] }, { headers: { "x-session-affinity": "ses_a" } })
    const a = mock.state.turns.at(-1).thread_id
    // the same words in another session are another thread, sent whole
    await post({ model: "smart", messages: next }, { headers: { "x-magpie-session": "ses_b" } })
    expect(mock.state.turns.at(-1).thread_id).not.toBe(a)
    expect(mock.state.turns.at(-1).text).toBe("User: the same opening line\n\nAssistant: x\n\nUser: and then")
    // in its own session it goes on in its thread
    await post({ model: "smart", messages: next }, { headers: { "x-session-affinity": "ses_a" } })
    expect(mock.state.turns.at(-1)).toMatchObject({ thread_id: a, text: "and then" })
  })

  test("what does not fit a 64 KB frame: schemas become signatures, long text an attachment", async () => {
    const tool = (i) => ({ type: "function", function: { name: `tool_${i}`, description: "d".repeat(900), parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } })
    const big = Array.from({ length: 80 }, (_, i) => tool(i))
    expect((await post({ model: "smart", tools: big, messages: [system, { role: "user", content: "hello" }] })).status).toBe(200)
    let turn = mock.state.turns.at(-1)
    expect(turn.custom_prompt).toContain("- tool_0(path*: string): " + "d".repeat(160) + "…\n")
    expect(turn.custom_prompt).not.toContain('"parameters"')
    expect(turn.text).toStartWith("hello\n\n")

    // more tools than one line each has room for: shorter lines, then the names alone
    expect((await post({ model: "smart", tools: Array.from({ length: 600 }, (_, i) => tool(i)), messages: [system, { role: "user", content: "hello" }] })).status).toBe(200)
    turn = mock.state.turns.at(-1)
    expect(turn.custom_prompt).toStartWith("You are a coding agent.")
    expect(turn.custom_prompt).toContain("- tool_599(path*: string): " + "d".repeat(60) + "…\n")
    expect((await post({ model: "smart", tools: Array.from({ length: 4000 }, (_, i) => tool(i)), messages: [system, { role: "user", content: "hello" }] })).status).toBe(200)
    turn = mock.state.turns.at(-1)
    expect(turn.custom_prompt).toContain("(names only")
    expect(turn.custom_prompt).toContain("tool_0, tool_1, tool_2")
    expect(turn.custom_prompt).toMatch(/, … and \d+ more\n/)
    expect(turn.custom_prompt).toContain("<client_tool_call>")

    // a system prompt longer than a message, in Chinese: shortened, the tools and the question kept
    const long = { role: "system", content: "你是一个编程助手。" + "规则：保持简洁。\n".repeat(20000) }
    expect((await post({ model: "smart", tools: big.slice(0, 20), messages: [long, { role: "user", content: "讲个笑话" }] })).status).toBe(200)
    turn = mock.state.turns.at(-1)
    expect(turn.custom_prompt).toStartWith("你是一个编程助手。")
    expect(turn.custom_prompt).toContain("shortened to fit")
    expect(turn.custom_prompt).toContain('"name": "tool_19"')
    expect(Buffer.byteLength(JSON.stringify(turn))).toBeGreaterThan(60_000)
    expect(turn.text).toStartWith("讲个笑话\n\n")
    expect(mock.state.refused).toEqual([])

    // refused although it was measured to fit: sent once more, smaller
    mock.state.limit = 50_000
    const res2 = await post({ model: "smart", tools: big, messages: [system, { role: "user", content: "x".repeat(40_000) }] })
    mock.state.limit = 65_250
    expect(res2.status).toBe(200)
    expect(mock.state.refused.length).toBe(1)
    expect(mock.state.refused[0]).toBeLessThanOrEqual(63_000)
    mock.state.refused.length = 0

    // what cannot be made to fit is said here, not sent
    const { fetch: send, baseURL } = await hooks.auth.loader(async () => auth)
    const turns = mock.state.turns.length
    const tiny = await plugin.server({ client: { auth: { set: async () => {} } }, directory: "/tmp" }, { oidc_base: mock.url, discovery_url: mock.url + "/sn", data_plane_url: mock.url, callback_port: 0, max_frame_bytes: 300 })
    const none = await (await tiny.auth.loader(async () => auth)).fetch(`${baseURL}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "smart", messages: [{ role: "user", content: "hello" }] }) })
    expect(none.status).toBe(400)
    expect((await none.json()).error).toMatchObject({ code: "context_length_exceeded" })
    expect(mock.state.turns.length).toBe(turns)
    expect(mock.state.refused).toEqual([])
    void send

    const log = "line\n".repeat(30000)
    const res = await post({ model: "smart", messages: [{ role: "user", content: "first" }, { role: "assistant", content: "ok" }, { role: "user", content: log }, { role: "assistant", content: "seen" }, { role: "user", content: "and now?" }] })
    expect(res.status).toBe(200)
    turn = mock.state.turns.at(-1)
    const upload = mock.state.uploads.at(-1)
    expect(upload).toMatchObject({ contentType: "text/plain", thread: turn.thread_id })
    expect(upload.text).toStartWith("User: first\n\nAssistant: ok\n\nUser: line\n")
    expect(turn.text).toContain(`attached file ${upload.name}`)
    expect(turn.text).toEndWith("User: and now?")
    expect(turn.attachments).toEqual([{ type: "file", name: upload.name, size: upload.size, mimeType: "text/plain", path: `/data/workspace/attached_files/${upload.name}`, attachmentId: upload.id, contentSha256: expect.any(String) }])
  })

  test("an inline image is sent as an attachment", async () => {
    const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64")
    await post({ model: "smart", messages: [{ role: "user", content: [{ type: "text", text: "what is this? " }, { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } }] }] })
    const turn = mock.state.turns.at(-1)
    expect(turn.text).toBe("what is this? [image: attached file image_1.png]")
    expect(turn.attachments[0]).toMatchObject({ type: "image", name: "image_1.png", mimeType: "image/png", size: 8 })
  })
})

describe("the account", () => {
  test("usage for magpie quota", async () => {
    expect(await hooks.auth.usage(async () => auth)).toEqual({
      plan: "Free Trial",
      user: "ada@example.com",
      until: "2026-12-19T13:53:55.000Z",
      windows: [
        { name: "Monthly", amount: 17, limit: 600, unit: "credits", display: "17 / 600 credits", resetsAt: "2026-12-01T00:00:00.000Z" },
        { name: "Session", amount: 3, limit: 100, unit: "credits", display: "3 / 100 credits" },
      ],
      signIn: "kept",
    })
    // a refusal is reported, and never marks the account
    expect(await hooks.auth.usage(async () => ({ ...auth, access: "wrong" }))).toMatchObject({ error: expect.stringContaining("401"), signIn: "kept" })
  })

  test("the model list follows the account's settings", async () => {
    const config = {}
    await hooks.config(config)
    const listed = config.provider["aws-quick"].models
    expect(Object.keys(await hooks.provider.models({ models: listed }, { auth }))).toEqual(["smart", "fast", "balanced", "auto"])
    const { accountModels } = _internal
    expect(Object.keys(accountModels(listed, { advanced_mode_enabled: true, model_slots: { fast: { enabled: false } } }))).toEqual(["smart", "balanced", "auto", "advanced"])
    expect(await hooks.provider.models({ models: listed }, { auth: { ...auth, accountId: "someone-else", access: "wrong" } })).toBe(listed)
  })

  test("magpie's conversation id travels in a header", async () => {
    const output = { headers: {} }
    await hooks["chat.headers"]({ model: { providerID: "aws-quick" }, sessionID: "ses_1" }, output)
    await hooks["chat.headers"]({ model: { providerID: "openai" }, sessionID: "ses_2" }, output)
    expect(output.headers).toEqual({ "x-aws-quick-conversation": "ses_1" })
  })
})

describe("renewal", () => {
  test("magpie's refresh hook returns the renewed fields", async () => {
    const next = await hooks.auth.refresh(auth)
    expect(next).toMatchObject({ access: "access-1", refresh: "refresh-1", accountId: "ada@example.com", clientId: "mock-client", deviceId: auth.deviceId })
    expect(next.expires).toBeGreaterThan(Date.now())
  })

  test("an account from before there were device ids sends none, and gets one with its renewal", async () => {
    const { deviceId: _id, ...old } = auth
    const { fetch: send, baseURL } = await hooks.auth.loader(async () => old)
    await send(`${baseURL}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "smart", messages: [{ role: "user", content: "ping" }] }) })
    expect(mock.state.dials.at(-1)).toBe("")
    expect(mock.state.connects.at(-1).outpostId).toBe("")
    const next = await hooks.auth.refresh(old)
    expect(_internal.oauth.isDeviceId(next.deviceId)).toBe(true)
    expect(next.deviceId).not.toBe(auth.deviceId)
    expect((await hooks.auth.refresh({ ...old, ...next })).deviceId).toBe(next.deviceId)
  })

  test("a refused refresh token asks for a new sign-in", async () => {
    await expect(hooks.auth.refresh({ ...auth, refresh: "revoked" })).rejects.toMatchObject({ signIn: "expired" })
    await expect(hooks.auth.refresh({ ...auth, refresh: "none" })).rejects.toMatchObject({ signIn: "expired" })
  })

  test("without the hook (OpenCode), an expired token is renewed once and saved", async () => {
    const before = mock.state.refreshes
    const old = { ...auth, expires: Date.now() - 1000 }
    const { fetch: send, baseURL } = await hooks.auth.loader(async () => old)
    const ask = () => send(`${baseURL}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "smart", messages: [{ role: "user", content: "ping" }] }) })
    const [a, b] = await Promise.all([ask(), ask()])
    expect([a.status, b.status]).toEqual([200, 200])
    expect(mock.state.refreshes).toBe(before + 1)
    expect(saved.at(-1)).toMatchObject({ type: "oauth", access: `access-${before + 1}`, accountId: "ada@example.com" })
  })

  test("Amazon Quick refusing the token marks the account", async () => {
    mock.state.rejectToken = auth.idToken
    const res = await post({ model: "smart", stream: true, messages: [{ role: "user", content: "ping" }] })
    expect(res.status).toBe(401)
    expect(res.headers.get("x-magpie-sign-in")).toBe("expired")
    mock.state.rejectToken = ""
  })
})
