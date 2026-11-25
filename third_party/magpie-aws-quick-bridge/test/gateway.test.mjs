// The standalone gateway against the local stand-in for Amazon Quick: the
// three APIs agents speak, the key, the account file and its renewal, and
// the CC Switch links.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { importLink } from "../gateway/ccswitch.mjs"
import { createGateway, listen, quickModel } from "../gateway/server.mjs"
import { plist } from "../gateway/service.mjs"
import * as store from "../gateway/store.mjs"
import * as oauth from "../plugin/oauth.mjs"
import { browserSignIn } from "../plugin/login.mjs"
import { settings } from "../plugin/settings.mjs"
import { startMock } from "./mock-upstream.mjs"

const KEY = "sk-quick-test"
let mock
let dir
let running
let base
let account

beforeAll(async () => {
  mock = startMock()
  dir = mkdtempSync(join(tmpdir(), "aqb-"))
  process.env.AWS_QUICK_BRIDGE_HOME = dir
  const options = { oidc_base: mock.url, discovery_url: mock.url + "/sn", data_plane_url: mock.url, callback_port: 0, request_timeout: "10s" }
  account = new store.Account()
  running = await listen(createGateway({ apiKey: KEY, account, options }), { port: 0, host: "127.0.0.1" })
  base = `http://127.0.0.1:${running.port}`

  // sign in the way the CLI does, and keep the account where the gateway reads it
  const started = await browserSignIn({ provider: "social" }, settings(options))
  let url = started.url
  for (let hops = 0; hops < 10; hops++) {
    const res = await fetch(url, { redirect: "manual" })
    if (res.status !== 302) break
    url = res.headers.get("location")
  }
  const { type: _type, ...fields } = await started.callback()
  store.saveAccount({ ...fields, type: "oauth" })
})

afterAll(() => {
  running.close()
  mock.stop()
  oauth.setEndpoints()
  rmSync(dir, { recursive: true, force: true })
  delete process.env.AWS_QUICK_BRIDGE_HOME
})

const call = (path, body, headers = {}) =>
  fetch(base + path, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", ...headers }, body: body && JSON.stringify(body) })

// A streamed answer as [event name, data] pairs.
async function events(res) {
  expect(res.status).toBe(200)
  expect(res.headers.get("content-type")).toContain("text/event-stream")
  const out = []
  for (const block of (await res.text()).split("\n\n")) {
    const name = /^event: (.+)$/m.exec(block)?.[1]
    const data = /^data: (.+)$/m.exec(block)?.[1]
    if (data && data !== "[DONE]") out.push([name, JSON.parse(data)])
  }
  return out
}

const thinking = () => [
  { type: "thinking_delta", payload: { delta: "hmm" } },
  { type: "text_delta", payload: { delta: "done" } },
  { type: "message_complete", payload: {} },
  { type: "turn_completed", payload: {} },
]

describe("the gateway", () => {
  test("the files are the owner's alone", () => {
    expect(statSync(join(dir, "account.json")).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    const cfg = store.config()
    expect(cfg.apiKey).toMatch(/^sk-quick-[0-9a-f]{48}$/)
    expect(store.config().apiKey).toBe(cfg.apiKey)
    expect(statSync(join(dir, "config.json")).mode & 0o777).toBe(0o600)
    expect(store.newKey()).not.toBe(cfg.apiKey)
  })

  test("the key is asked for, in each API's own words", async () => {
    expect((await fetch(base + "/health")).status).toBe(200)
    const chat = await fetch(base + "/v1/models")
    expect(chat.status).toBe(401)
    expect((await chat.json()).error.code).toBe("invalid_api_key")
    const messages = await fetch(base + "/v1/messages", { method: "POST", headers: { "x-api-key": "wrong" }, body: "{}" })
    expect(messages.status).toBe(401)
    expect(await messages.json()).toMatchObject({ type: "error", error: { type: "authentication_error" } })
    expect((await fetch(base + "/v1/models", { headers: { "x-api-key": KEY } })).status).toBe(200)
    expect((await call("/v1/nothing")).status).toBe(404)
    expect((await fetch(base + "/v1/messages", { method: "POST", headers: { "x-api-key": KEY }, body: "not json" })).status).toBe(400)
  })

  test("the models are Amazon Quick's modes, and other names are answered by them", async () => {
    const list = await (await call("/v1/models")).json()
    expect(list.data.map((m) => m.id)).toEqual(["smart", "fast", "balanced", "auto"])
    expect(quickModel("claude-haiku-4-5", "smart")).toBe("fast")
    expect(quickModel("claude-opus-4-5", "smart")).toBe("smart")
    expect(quickModel("gpt-5-codex", "balanced")).toBe("balanced")
    expect(quickModel("aws-quick/fast", "smart")).toBe("fast")
  })

  test("chat completions, with and without /v1", async () => {
    const body = { model: "fast", messages: [{ role: "user", content: "ping" }] }
    const whole = await (await call("/v1/chat/completions", body)).json()
    expect(whole.choices[0].message.content).toBe("pong from fast")
    expect(whole.usage).toMatchObject({ prompt_tokens: 15, completion_tokens: 5 })
    const streamed = await events(await call("/chat/completions", { ...body, stream: true }))
    expect(streamed.map(([, e]) => e.choices?.[0]?.delta?.content ?? "").join("")).toBe("pong from fast")
  })

  test("the session is opened with the account's device id", async () => {
    const id = account.peek().deviceId
    expect(oauth.isDeviceId(id)).toBe(true)
    await call("/v1/chat/completions", { model: "fast", messages: [{ role: "user", content: "ping" }] })
    expect(mock.state.dials.at(-1)).toBe(id)
    expect(mock.state.connects.at(-1).outpostId).toBe(id)
  })

  test("the same account signing in again keeps its device id, another account gets its own", () => {
    const was = JSON.parse(readFileSync(join(dir, "account.json"), "utf8"))
    const again = { ...was, deviceId: "11111111-2222-4333-8444-555555555555", access: "access-new" }
    store.signedIn(again)
    expect(account.peek()).toMatchObject({ deviceId: was.deviceId, access: "access-new", type: "oauth" })
    store.signedIn({ ...again, accountId: "grace@example.com" })
    expect(account.peek().deviceId).toBe(again.deviceId)
    store.saveAccount(was)
  })

  test("a session header (OpenCode's x-session-affinity) names the conversation", async () => {
    const hi = { role: "user", content: "one opening line" }
    const next = [hi, { role: "assistant", content: "x" }, { role: "user", content: "and then" }]
    await call("/v1/chat/completions", { model: "smart", messages: [hi] }, { "x-session-affinity": "ses_a" })
    const a = mock.state.turns.at(-1).thread_id
    await call("/v1/chat/completions", { model: "smart", messages: next }, { "x-session-id": "ses_b" })
    expect(mock.state.turns.at(-1).thread_id).not.toBe(a)
    await call("/v1/chat/completions", { model: "smart", messages: next }, { "x-session-affinity": "ses_a" })
    expect(mock.state.turns.at(-1)).toMatchObject({ thread_id: a, text: "and then" })
  })
})

describe("Anthropic Messages (Claude Code)", () => {
  const tools = [{ name: "Read", description: "Read a file", input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } }]

  test("a message, with Claude Code's system blocks", async () => {
    const res = await call("/v1/messages?beta=true", {
      model: "claude-haiku-4-5",
      max_tokens: 100,
      system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=1; cch=abc;" }, { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }, { type: "text", text: "You are a coding agent.", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }, { role: "system", content: [{ type: "text", text: "Today is Sunday." }] }],
    })
    const body = await res.json()
    expect(body).toMatchObject({
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5",
      content: [{ type: "text", text: "pong from fast" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 12, output_tokens: 5, cache_read_input_tokens: 3 },
    })
    expect(body.id).toStartWith("msg_")
    const turn = mock.state.turns.at(-1)
    expect(turn.custom_prompt).toContain("You are a coding agent.")
    expect(turn.custom_prompt).toContain("Today is Sunday.")
    expect(turn.custom_prompt).not.toContain("x-anthropic-billing-header")
    expect(turn.custom_prompt).not.toContain("You are Claude Code")
    expect(turn.custom_prompt).toContain("This conversation comes from a coding agent")
  })

  test("a streamed tool call, and its result on the next request", async () => {
    const ask = { role: "user", content: "Please use the tool Read" }
    const stream = await events(await call("/v1/messages", { model: "smart", max_tokens: 100, stream: true, tools: [...tools, { name: "Later", input_schema: { type: "object" }, defer_loading: true }], messages: [ask] }))
    expect(stream.map(([name]) => name)).toEqual([
      "message_start",
      "ping",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])
    for (const [name, data] of stream) expect(data.type).toBe(name)
    expect(mock.state.turns.at(-1).custom_prompt).not.toContain("Later")
    const use = stream[5][1].content_block
    expect(use).toMatchObject({ type: "tool_use", name: "Read", input: {} })
    expect(stream[5][1].index).toBe(1)
    expect(JSON.parse(stream[6][1].delta.partial_json)).toEqual({ city: "Paris" })
    expect(stream[8][1]).toMatchObject({ delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } })

    const next = await call("/v1/messages", {
      model: "smart",
      max_tokens: 100,
      tools,
      messages: [
        ask,
        { role: "assistant", content: [{ type: "text", text: "Let me check." }, { type: "tool_use", id: use.id, name: "Read", input: { city: "Paris" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: [{ type: "text", text: "sunny" }] }] },
      ],
    })
    expect((await next.json()).content).toEqual([{ type: "text", text: "pong from smart" }])
    expect(mock.state.turns.at(-1).text).toContain("sunny")
  })

  test("images in a tool result reach Amazon Quick like those of a user message", async () => {
    const png = (hex) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from(hex, "hex").toString("base64") } })
    const ask = (result, extra = []) => ({
      model: "smart",
      max_tokens: 100,
      tools,
      messages: [
        { role: "user", content: "Read a.png" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a.png" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", ...result }, ...extra] },
      ],
    })
    const sent = async (body, count) => {
      const before = mock.state.uploads.length
      expect((await call("/v1/messages", body)).status).toBe(200)
      const uploads = mock.state.uploads.slice(before)
      expect(uploads.length).toBe(count)
      const turn = mock.state.turns.at(-1)
      expect(turn.text).not.toMatch(/\[image\](?!:)/)
      expect((turn.attachments ?? []).map((a) => a.name)).toEqual(uploads.map((u) => u.name))
      for (const u of uploads) expect(turn.text).toContain(`attached file ${u.name}`)
      return { turn, uploads }
    }
    // one image
    let { turn, uploads } = await sent(ask({ content: [png("89504e470d0a1a0a")] }), 1)
    expect(uploads[0]).toMatchObject({ contentType: "image/png" })
    expect(turn.attachments[0]).toMatchObject({ type: "image", mimeType: "image/png", size: 8 })
    expect(turn.text).toContain("Tool result (call_id=toolu_1, name=Read): [image: attached file image_1_")
    // two images, with text between
    ;({ turn } = await sent(ask({ content: [{ type: "text", text: "first" }, png("89504e47"), { type: "text", text: "second" }, png("89504e470d0a")] }), 2))
    expect(turn.text).toMatch(/first\n\[image: attached file image_1_\w+\.png\]\nsecond\n\[image: attached file image_2_\w+\.png\]/)
    // a failed result keeps its "Error:" lead; an image in the same message's text goes too
    ;({ turn } = await sent(ask({ is_error: true, content: [{ type: "text", text: "bad" }, png("89504e47")] }, [{ type: "text", text: "look" }, png("ffd8ffe0")]), 2))
    expect(turn.text).toMatch(/Tool result \(call_id=toolu_1, name=Read\): Error: bad\n\[image: attached file image_1_/)
    expect(turn.text).toContain("User: look")
    // text alone is the same as before
    ;({ turn } = await sent(ask({ content: [{ type: "text", text: "plain" }] }), 0))
    expect(turn.text).toContain("Tool result (call_id=toolu_1, name=Read): plain")
    ;({ turn } = await sent(ask({ content: "a string", is_error: true }), 0))
    expect(turn.text).toContain("Tool result (call_id=toolu_1, name=Read): Error: a string")
    // streamed the same way
    const before = mock.state.uploads.length
    await events(await call("/v1/messages", { ...ask({ content: [png("89504e47")] }), stream: true }))
    expect(mock.state.uploads.length).toBe(before + 1)
    expect(mock.state.turns.at(-1).attachments).toHaveLength(1)
  })

  test("thinking is a block of its own, when asked for", async () => {
    mock.state.script = thinking
    const body = { model: "smart", max_tokens: 100, messages: [{ role: "user", content: "think" }] }
    const shown = await (await call("/v1/messages", { ...body, thinking: { type: "enabled", budget_tokens: 2000 } })).json()
    expect(shown.content).toEqual([{ type: "thinking", thinking: "hmm", signature: "" }, { type: "text", text: "done" }])
    const stream = await events(await call("/v1/messages", { ...body, stream: true, thinking: { type: "adaptive" } }))
    expect(stream.filter(([name]) => name === "content_block_start").map(([, e]) => e.content_block.type)).toEqual(["thinking", "text"])
    const hidden = await (await call("/v1/messages", { ...body, thinking: { type: "adaptive", display: "omitted" } })).json()
    expect(hidden.content).toEqual([{ type: "text", text: "done" }])
    mock.state.script = null
  })

  test("a token whose expiry is not known is renewed on first use", async () => {
    const before = account.peek()
    store.saveAccount({ ...before, expires: 0 })
    const refreshes = mock.state.refreshes
    const res = await call("/v1/messages", { model: "smart", max_tokens: 10, messages: [{ role: "user", content: "hi" }] })
    expect(res.status).toBe(200)
    expect(mock.state.refreshes).toBe(refreshes + 1)
    expect(account.peek().expires).toBeGreaterThan(Date.now())
    // known from then on: the next request renews nothing
    await call("/v1/messages", { model: "smart", max_tokens: 10, messages: [{ role: "user", content: "hi" }] })
    expect(mock.state.refreshes).toBe(refreshes + 1)
  })

  test("a reply the content filter cuts off midway is asked again, unseen", async () => {
    const tools = [{ name: "Read", description: "Read a file", input_schema: { type: "object", properties: { file_path: { type: "string" } } } }]
    const notice = "That content did not pass our automated check. Try asking again."
    const ok = [
      { type: "thinking_delta", payload: { delta: "again" } },
      { type: "text_delta", payload: { delta: 'Reading. <client_tool_call>{"name":"Read","arguments":{"file_path":"a.txt"}}</client_tool_call>' } },
      { type: "message_complete", payload: {} },
      { type: "turn_completed", payload: {} },
    ]
    const body = { model: "smart", max_tokens: 100, stream: true, tools, thinking: { type: "adaptive" }, messages: [{ role: "user", content: "read a.txt" }] }
    for (const failure of [
      // the notice as text, then an error event
      [{ type: "text_delta", payload: { delta: notice } }, { type: "stream_error", payload: { message: "content filter" } }],
      // the notice as a whole, finished reply
      [{ type: "text_delta", payload: { delta: notice } }, { type: "message_complete", payload: {} }, { type: "turn_completed", payload: {} }],
    ]) {
      let n = 0
      mock.state.script = () => (n++ === 0 ? [{ type: "thinking_delta", payload: { delta: "first" } }, ...failure] : ok)
      const stream = await events(await call("/v1/messages", body))
      expect(n).toBe(2)
      expect(JSON.stringify(stream)).not.toContain("automated check")
      expect(stream.some(([name]) => name === "error")).toBe(false)
      const texts = stream.filter(([, e]) => e.delta?.type === "text_delta").map(([, e]) => e.delta.text).join("")
      expect(texts).toBe("Reading. ")
      expect(stream.find(([, e]) => e.content_block?.type === "tool_use")[1].content_block.name).toBe("Read")
      expect(stream.find(([name]) => name === "message_delta")[1].delta.stop_reason).toBe("tool_use")
    }
    // one that keeps failing ends as a retryable error, after four retries
    let n = 0
    mock.state.script = () => (n++, [{ type: "thinking_delta", payload: { delta: "x" } }, { type: "stream_error", payload: { message: "content filter" } }])
    const stream = await events(await call("/v1/messages", body))
    expect(n).toBe(5)
    expect(stream.find(([name]) => name === "error")[1].error.type).toBe("overloaded_error")
    mock.state.script = null
  })

  test("the filter's notice as a guardrail event is asked again; a real block is not", async () => {
    const notice = "That content did not pass our automated check. Try asking again - a small rephrase usually helps."
    const ok = [{ type: "text_delta", payload: { delta: "fine" } }, { type: "message_complete", payload: {} }, { type: "turn_completed", payload: {} }]
    for (const stream of [false, true]) {
      let n = 0
      mock.state.script = () => (n++ < 2 ? [{ type: "guardrail_blocked", payload: { message: notice } }] : ok)
      const res = await call("/v1/messages", { model: "smart", max_tokens: 10, stream, tools, messages: [{ role: "user", content: "hi" }] })
      expect(res.status).toBe(200)
      expect(await res.text()).toContain("fine")
      expect(n).toBe(3)
    }
    // stopped every time: still the guardrail's 400
    let n = 0
    mock.state.script = () => (n++, [{ type: "guardrail_blocked", payload: { message: notice } }])
    const res = await call("/v1/messages", { model: "smart", max_tokens: 10, stream: true, tools, messages: [{ role: "user", content: "hi" }] })
    expect(res.status).toBe(400)
    expect(n).toBe(5)
    // a policy block is answered at once
    n = 0
    mock.state.script = () => (n++, [{ type: "guardrail_blocked", payload: { message: "blocked by policy" } }])
    expect((await call("/v1/messages", { model: "smart", max_tokens: 10, stream: true, tools, messages: [{ role: "user", content: "bad" }] })).status).toBe(400)
    expect(n).toBe(1)
    mock.state.script = null
  })

  test("tokens are estimated, errors are Anthropic's", async () => {
    const count = await (await call("/v1/messages/count_tokens", { model: "smart", messages: [{ role: "user", content: "x".repeat(400) }] })).json()
    expect(count.input_tokens).toBeGreaterThan(100)
    mock.state.script = () => [{ type: "guardrail_blocked", payload: { message: "blocked by policy" } }]
    const res = await call("/v1/messages", { model: "smart", max_tokens: 10, messages: [{ role: "user", content: "bad" }] })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ type: "error", error: { type: "invalid_request_error" } })
    mock.state.script = null
  })
})

describe("OpenAI Responses (Codex)", () => {
  const input = (text) => [
    { type: "message", role: "developer", content: [{ type: "input_text", text: "You are Codex." }] },
    { type: "message", role: "user", content: [{ type: "input_text", text }] },
  ]
  const tools = [
    { type: "function", name: "exec_command", description: "Run a command", strict: false, parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } },
    { type: "namespace", name: "agents", description: "Sub-agents", tools: [{ type: "function", name: "spawn", description: "Start one", parameters: { type: "object", properties: {} } }] },
    { type: "custom", name: "apply_patch", description: "Edit files", format: { type: "grammar", syntax: "lark", definition: "start: /.+/" } },
    { type: "web_search" },
  ]

  test("a response", async () => {
    const body = await (await call("/v1/responses", { model: "gpt-5-codex", instructions: "Be brief.", input: "ping" })).json()
    expect(body).toMatchObject({ object: "response", status: "completed", model: "gpt-5-codex", output_text: "pong from smart", usage: { input_tokens: 15, output_tokens: 5, input_tokens_details: { cached_tokens: 3 } } })
    expect(body.output[0]).toMatchObject({ type: "message", role: "assistant", content: [{ type: "output_text", text: "pong from smart" }] })
    expect(mock.state.turns.at(-1).custom_prompt).toContain("Be brief.")
    const stored = await call("/v1/responses", { model: "smart", input: "ping", previous_response_id: "resp_1" })
    expect(stored.status).toBe(400)
  })

  test("a streamed function call, and its output on the next request", async () => {
    const stream = await events(await call("/v1/responses", { model: "smart", stream: true, tools, input: input("Please use the tool exec_command") }, { "session-id": "codex-1" }))
    for (const [name, data] of stream) expect(data.type).toBe(name)
    expect(stream.map(([, e]) => e.sequence_number)).toEqual(stream.map((_, i) => i))
    expect(stream.map(([name]) => name).filter((n) => !n.includes("delta"))).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.output_item.added",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ])
    const done = stream.at(-1)[1].response
    expect(done.output.map((i) => i.type)).toEqual(["message", "function_call"])
    const fc = done.output[1]
    expect(fc).toMatchObject({ name: "exec_command", arguments: '{"city":"Paris"}', status: "completed" })
    expect(mock.state.turns.at(-1).custom_prompt).toContain("You are Codex.")

    const next = await call("/v1/responses", {
      model: "smart",
      tools,
      input: [...input("Please use the tool exec_command"), done.output[0], fc, { type: "function_call_output", call_id: fc.call_id, output: "it is sunny" }],
    }, { "session-id": "codex-1" })
    expect((await next.json()).output_text).toBe("pong from smart")
    expect(mock.state.turns.at(-1).text).toContain("it is sunny")
  })

  test("a tool in a namespace and a free-text tool come back as Codex names them", async () => {
    const spaced = await (await call("/v1/responses", { model: "smart", tools, input: input("Please use the tool agents__spawn") })).json()
    expect(spaced.output.at(-1)).toMatchObject({ type: "function_call", namespace: "agents", name: "spawn" })
    mock.state.script = () => [
      { type: "text_delta", payload: { delta: '<client_tool_call>{"name":"apply_patch","arguments":{"input":"*** Begin Patch"}}</client_tool_call>' } },
      { type: "message_complete", payload: {} },
      { type: "turn_completed", payload: {} },
    ]
    const custom = await (await call("/v1/responses", { model: "smart", tools, input: input("patch it") })).json()
    expect(custom.output.at(-1)).toMatchObject({ type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch" })
    mock.state.script = null
  })

  test("thinking is a reasoning item", async () => {
    mock.state.script = thinking
    const stream = await events(await call("/v1/responses", { model: "smart", stream: true, input: "think" }))
    expect(stream.at(-1)[1].response.output.map((i) => i.type)).toEqual(["reasoning", "message"])
    expect(stream.at(-1)[1].response.output[0].summary).toEqual([{ type: "summary_text", text: "hmm" }])
    mock.state.script = null
  })
})

describe("the account", () => {
  test("a token near its end is renewed once and saved", async () => {
    const before = mock.state.refreshes
    const saved = JSON.parse(readFileSync(join(dir, "account.json"), "utf8"))
    store.saveAccount({ ...saved, expires: Date.now() + 60_000 })
    const ask = () => call("/v1/messages", { model: "smart", max_tokens: 10, messages: [{ role: "user", content: "ping" }] })
    const [a, b] = await Promise.all([ask(), ask()])
    expect([a.status, b.status]).toEqual([200, 200])
    expect(mock.state.refreshes).toBe(before + 1)
    const now = JSON.parse(readFileSync(join(dir, "account.json"), "utf8"))
    expect(now).toMatchObject({ type: "oauth", access: `access-${before + 1}`, accountId: "ada@example.com" })
    expect(now.expires).toBeGreaterThan(Date.now() + 3000_000)
  })

  test("a token Amazon Quick refuses early is renewed and the request asked again", async () => {
    const before = mock.state.refreshes
    mock.state.rejectToken = account.peek().idToken
    const res = await call("/v1/chat/completions", { model: "smart", messages: [{ role: "user", content: "ping" }] })
    expect(res.status).toBe(200)
    expect(mock.state.refreshes).toBe(before + 1)
    mock.state.rejectToken = ""
  })

  test("a refused renewal, and no account, ask for a sign-in", async () => {
    const saved = JSON.parse(readFileSync(join(dir, "account.json"), "utf8"))
    store.saveAccount({ ...saved, refresh: "revoked", expires: Date.now() - 1000 })
    const expired = await call("/v1/messages", { model: "smart", max_tokens: 10, messages: [{ role: "user", content: "ping" }] })
    expect(expired.status).toBe(401)
    expect((await expired.json()).error.message).toContain("magpie-aws-quick-bridge login")
    store.removeAccount()
    const none = await call("/v1/responses", { model: "smart", input: "ping" })
    expect(none.status).toBe(401)
    expect((await none.json()).error.message).toContain("not signed in")
    // signing in while the gateway runs is picked up
    store.saveAccount(saved)
    expect((await call("/v1/responses", { model: "smart", input: "ping" })).status).toBe(200)
  })
})

describe("CC Switch", () => {
  const link = (app) => new URL(importLink(app, { base: "http://127.0.0.1:18765/", apiKey: KEY }))

  test("each app is given the API it speaks", () => {
    const claude = link("claude")
    expect(claude.protocol + "//" + claude.host + claude.pathname).toBe("ccswitch://v1/import")
    expect(Object.fromEntries(claude.searchParams)).toMatchObject({
      resource: "provider",
      app: "claude",
      name: "Amazon Quick",
      endpoint: "http://127.0.0.1:18765",
      apiKey: KEY,
      model: "smart",
      haikuModel: "fast",
      apiFormat: "anthropic",
    })
    expect(Object.fromEntries(link("codex").searchParams)).toMatchObject({ app: "codex", endpoint: "http://127.0.0.1:18765/v1", apiFormat: "openai_responses" })
    expect(Object.fromEntries(link("opencode").searchParams)).toMatchObject({ app: "opencode", endpoint: "http://127.0.0.1:18765/v1", apiFormat: "openai_chat" })
    expect(importLink("claude", { base: "http://127.0.0.1:18765", apiKey: KEY })).not.toContain("+")
    expect(() => importLink("gemini", { base: "http://127.0.0.1:18765", apiKey: KEY })).toThrow("unknown app")
  })

  test("the macOS service runs serve with this runtime", () => {
    const text = plist({ runtime: "/usr/local/bin/node", script: "/opt/a&b/cli.mjs", env: { PATH: "/usr/bin" } })
    expect(text).toContain("<string>/usr/local/bin/node</string>")
    expect(text).toContain("<string>/opt/a&amp;b/cli.mjs</string>")
    expect(text).toContain("<string>serve</string>")
  })
})
