// OpenAI Responses (POST /v1/responses), which Codex speaks, on top of the
// plugin's chat completions: the request is rewritten as one, and its answer
// is rewritten back, streamed or whole. Nothing is stored between requests,
// so previous_response_id is refused: Codex sends the conversation itself.

import { randomUUID } from "node:crypto"
import { eventStream, failure, textOf, turnEvents, turnResult } from "./sse.mjs"

export const error = (status, message, code = "") =>
  Response.json({ error: { message, type: status === 401 ? "authentication_error" : status < 500 ? "invalid_request_error" : "server_error", code: code || null } }, { status })

const id = (prefix) => prefix + randomUUID().replaceAll("-", "")
const TEXT = ["input_text", "output_text", "text", "summary_text", "reasoning_text"]

function content(value) {
  if (typeof value === "string") return value
  const parts = []
  for (const p of Array.isArray(value) ? value : []) {
    if (TEXT.includes(p?.type) && typeof p.text === "string") parts.push({ type: "text", text: p.text })
    else if (p?.type === "input_image") {
      const url = typeof p.image_url === "string" ? p.image_url : p.image_url?.url
      parts.push(url ? { type: "image_url", image_url: { url } } : { type: "text", text: "[image]" })
    } else if (p?.type === "input_file") parts.push({ type: "text", text: `[file${p.filename ? ` ${p.filename}` : ""}]` })
  }
  return parts.every((p) => p.type === "text") ? parts.map((p) => p.text).join("\n") : parts
}

// A tool inside a namespace (Codex groups MCP and sub-agent tools this way)
// under one name, as chat tools have no namespaces.
const flat = (namespace, name) => (namespace ? `${namespace}${namespace.endsWith("__") ? "" : "__"}${name}` : String(name ?? ""))

const output = (value) => (typeof value === "string" ? value : Array.isArray(value) ? textOf(value, TEXT) || JSON.stringify(value) : value == null ? "" : JSON.stringify(value))

// The `input` items as chat messages. A model's tool calls are items of
// their own here; in chat they hang off the assistant message before them.
function messages(input) {
  if (typeof input === "string") return input ? [{ role: "user", content: input }] : []
  const out = []
  const call = (callId, name, args) => {
    const entry = { id: String(callId ?? ""), type: "function", function: { name: String(name ?? ""), arguments: args } }
    const last = out.at(-1)
    if (last?.role === "assistant") (last.tool_calls ??= []).push(entry)
    else out.push({ role: "assistant", content: null, tool_calls: [entry] })
  }
  for (const item of Array.isArray(input) ? input : []) {
    if (!item || typeof item !== "object") continue
    const type = item.type ?? (item.role ? "message" : "")
    if (type === "message") {
      const role = item.role === "developer" ? "system" : item.role
      const body = content(item.content)
      if (!["user", "assistant", "system"].includes(role) || !body?.length) continue
      out.push({ role, content: body })
    } else if (type === "function_call") call(item.call_id ?? item.id, flat(item.namespace, item.name), typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}))
    else if (type === "custom_tool_call") call(item.call_id ?? item.id, item.name, JSON.stringify({ input: item.input ?? "" }))
    else if (type === "local_shell_call") call(item.call_id ?? item.id, "local_shell", JSON.stringify(item.action ?? {}))
    else if (type === "function_call_output" || type === "custom_tool_call_output" || type === "local_shell_call_output")
      out.push({ role: "tool", tool_call_id: String(item.call_id ?? ""), content: output(item.output) })
    // reasoning items, web search calls and the like have nothing to resend
  }
  return out
}

const INPUT = { type: "object", properties: { input: { type: "string", description: "The tool's whole input, as plain text" } }, required: ["input"] }
const SHELL = {
  type: "object",
  properties: { command: { type: "array", items: { type: "string" } }, workdir: { type: "string" }, timeout_ms: { type: "integer" } },
  required: ["command"],
}

// The tools the client runs, as chat tools. A "custom" tool takes free text
// instead of JSON arguments; it is offered with one string argument, and
// its calls are turned back in the answer (`custom` names them, `spaces`
// the ones that came in a namespace).
function tools(list) {
  const out = []
  const custom = new Set()
  const spaces = new Map()
  const fn = (t, name = t.name) => out.push({ type: "function", function: { name, description: t.description ?? "", parameters: t.parameters ?? { type: "object", properties: {} } } })
  for (const t of Array.isArray(list) ? list : []) {
    if (t?.type === "function" && t.name) fn(t)
    else if (t?.type === "namespace" && t.name) {
      for (const inner of Array.isArray(t.tools) ? t.tools : []) {
        if (inner?.type !== "function" || !inner.name) continue
        spaces.set(flat(t.name, inner.name), { namespace: t.name, name: inner.name })
        fn(inner, flat(t.name, inner.name))
      }
    } else if (t?.type === "custom" && t.name) {
      custom.add(t.name)
      const grammar = typeof t.format?.definition === "string" ? `\n\nThe input follows this ${t.format.syntax ?? ""} grammar:\n${t.format.definition.slice(0, 3000)}` : ""
      out.push({ type: "function", function: { name: t.name, description: (t.description ?? "") + grammar, parameters: INPUT } })
    } else if (t?.type === "local_shell") out.push({ type: "function", function: { name: "local_shell", description: "Runs a command on the user's computer and returns its output.", parameters: SHELL } })
    // web_search and other tools OpenAI runs itself are not offered
  }
  return { tools: out, custom, spaces }
}

function toolChoice(choice) {
  if (choice === "none" || choice === "required") return choice
  if (choice && typeof choice === "object" && choice.name) return { type: "function", function: { name: choice.name } }
  return undefined
}

// The request as a chat completions body, and what the answer needs of it.
export function toChat(body, headers) {
  const offered = tools(body.tools)
  const chat = {
    model: body.model,
    messages: [...(typeof body.instructions === "string" && body.instructions.trim() ? [{ role: "system", content: body.instructions }] : []), ...messages(body.input)],
    stream: body.stream === true,
    stream_options: { include_usage: true },
  }
  if (offered.tools.length) chat.tools = offered.tools
  const choice = toolChoice(body.tool_choice)
  if (choice) chat.tool_choice = choice
  if (body.parallel_tool_calls === false) chat.parallel_tool_calls = false
  if (body.reasoning?.effort) chat.reasoning_effort = body.reasoning.effort
  return {
    chat,
    custom: offered.custom,
    spaces: offered.spaces,
    model: String(body.model ?? ""),
    // Codex names its session in these
    conversation: String(headers?.get("session-id") ?? headers?.get("session_id") ?? headers?.get("conversation_id") ?? body.prompt_cache_key ?? ""),
  }
}

const usage = (u) => ({
  input_tokens: u.input + u.cached,
  input_tokens_details: { cached_tokens: u.cached },
  output_tokens: u.output,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: u.total || u.input + u.cached + u.output,
})

function callItem(call, { custom, spaces }) {
  if (custom.has(call.name)) {
    let input = call.arguments
    try {
      const args = JSON.parse(call.arguments)
      input = typeof args?.input === "string" ? args.input : typeof args === "string" ? args : call.arguments
    } catch {}
    return { id: id("ctc_"), type: "custom_tool_call", status: "completed", call_id: call.id, name: call.name, input }
  }
  if (call.name === "local_shell") {
    let action = {}
    try {
      action = JSON.parse(call.arguments)
    } catch {}
    return { id: id("lsh_"), type: "local_shell_call", status: "completed", call_id: call.id, action: { type: "exec", ...action } }
  }
  return { id: id("fc_"), type: "function_call", status: "completed", call_id: call.id, ...(spaces.get(call.name) ?? { name: call.name }), arguments: call.arguments }
}

const reasoningItem = (text) => ({ id: id("rs_"), type: "reasoning", summary: [{ type: "summary_text", text }] })
const messageItem = (text, itemId = id("msg_")) => ({ id: itemId, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] })

// The chat completions answer as a Responses one.
export async function fromChat(response, req) {
  if (!response.ok) {
    const f = await failure(response)
    return error(f.status, f.message, f.code)
  }
  const base = {
    id: id("resp_"),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: req.model,
    error: null,
    incomplete_details: null,
    parallel_tool_calls: req.chat.parallel_tool_calls !== false,
    tool_choice: "auto",
    store: false,
  }

  if (!req.chat.stream) {
    const res = turnResult(await response.json())
    const items = []
    if (res.reasoning) items.push(reasoningItem(res.reasoning))
    if (res.text) items.push(messageItem(res.text))
    for (const c of res.calls) items.push(callItem(c, req))
    return Response.json({ ...base, status: "completed", output: items, output_text: res.text, usage: usage(res.usage) })
  }

  return eventStream(async (emit) => {
    let sequence = 0
    const send = (type, data) => emit(type, { type, sequence_number: sequence++, ...data })
    const items = []
    send("response.created", { response: { ...base, status: "in_progress", output: [], usage: null } })
    send("response.in_progress", { response: { ...base, status: "in_progress", output: [], usage: null } })

    // the item being written: { kind: "reasoning" | "message", id, text }
    let open = null
    const close = () => {
      if (!open) return
      const output_index = items.length
      const { kind, id: item_id, text } = open
      open = null
      if (kind === "reasoning") {
        send("response.reasoning_summary_text.done", { item_id, output_index, summary_index: 0, text })
        send("response.reasoning_summary_part.done", { item_id, output_index, summary_index: 0, part: { type: "summary_text", text } })
        items.push({ ...reasoningItem(text), id: item_id })
      } else {
        send("response.output_text.done", { item_id, output_index, content_index: 0, text, logprobs: [] })
        send("response.content_part.done", { item_id, output_index, content_index: 0, part: { type: "output_text", text, annotations: [] } })
        items.push(messageItem(text, item_id))
      }
      send("response.output_item.done", { output_index, item: items.at(-1) })
    }
    const write = (kind, text) => {
      if (open?.kind !== kind) {
        close()
        const output_index = items.length
        open = { kind, id: id(kind === "reasoning" ? "rs_" : "msg_"), text: "" }
        if (kind === "reasoning") {
          send("response.output_item.added", { output_index, item: { id: open.id, type: "reasoning", summary: [] } })
          send("response.reasoning_summary_part.added", { item_id: open.id, output_index, summary_index: 0, part: { type: "summary_text", text: "" } })
        } else {
          send("response.output_item.added", { output_index, item: { id: open.id, type: "message", status: "in_progress", role: "assistant", content: [] } })
          send("response.content_part.added", { item_id: open.id, output_index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } })
        }
      }
      open.text += text
      const output_index = items.length
      if (kind === "reasoning") send("response.reasoning_summary_text.delta", { item_id: open.id, output_index, summary_index: 0, delta: text })
      else send("response.output_text.delta", { item_id: open.id, output_index, content_index: 0, delta: text, logprobs: [] })
    }

    for await (const event of turnEvents(response)) {
      if (event.type === "reasoning" || event.type === "text") write(event.type === "text" ? "message" : "reasoning", event.text)
      else if (event.type === "tool") {
        close()
        const output_index = items.length
        const item = callItem(event.call, req)
        const blank = item.type === "function_call" ? { arguments: "" } : item.type === "custom_tool_call" ? { input: "" } : {}
        send("response.output_item.added", { output_index, item: { ...item, ...blank, status: "in_progress" } })
        if (item.type === "function_call") {
          send("response.function_call_arguments.delta", { item_id: item.id, output_index, delta: item.arguments })
          send("response.function_call_arguments.done", { item_id: item.id, output_index, arguments: item.arguments })
        } else if (item.type === "custom_tool_call") {
          send("response.custom_tool_call_input.delta", { item_id: item.id, output_index, delta: item.input })
          send("response.custom_tool_call_input.done", { item_id: item.id, output_index, input: item.input })
        }
        items.push(item)
        send("response.output_item.done", { output_index, item })
      } else if (event.type === "error") {
        close()
        send("response.failed", { response: { ...base, status: "failed", output: items, usage: null, error: { code: "server_error", message: event.message } } })
      } else if (event.type === "done") {
        close()
        send("response.completed", { response: { ...base, status: "completed", output: items, usage: usage(event.usage) } })
      }
    }
  })
}
