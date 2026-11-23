// Anthropic Messages (POST /v1/messages), which Claude Code speaks, on top
// of the plugin's chat completions: the request is rewritten as one, and
// its answer is rewritten back, streamed or whole.

import { randomUUID } from "node:crypto"
import { agentNeutral } from "../plugin/messages.mjs"
import { eventStream, failure, textOf, turnEvents, turnResult } from "./sse.mjs"

const TYPES = { 400: "invalid_request_error", 401: "authentication_error", 403: "permission_error", 404: "not_found_error", 413: "request_too_large", 429: "rate_limit_error", 529: "overloaded_error" }

export const error = (status, message) => Response.json({ type: "error", error: { type: TYPES[status] ?? "api_error", message } }, { status })

// Claude Code's billing line and its "You are Claude Code" opening are
// taken care of where every caller's instructions are read (agentNeutral).
const system = (value) => agentNeutral(textOf(typeof value === "string" ? [{ type: "text", text: value }] : value))

function image(block) {
  const s = block?.source
  if (s?.type === "base64" && s.data) return { type: "image_url", image_url: { url: `data:${s.media_type || "image/png"};base64,${s.data}` } }
  if (s?.type === "url" && s.url) return { type: "image_url", image_url: { url: s.url } }
  return null
}

function resultText(block) {
  const parts = typeof block.content === "string" ? [block.content] : []
  for (const p of Array.isArray(block.content) ? block.content : []) {
    if (p?.type === "text" && typeof p.text === "string") parts.push(p.text)
    else if (p?.type === "image") parts.push("[image]")
    else if (p?.type === "tool_reference" && p.tool_name) parts.push(`Tool loaded: ${p.tool_name}`)
  }
  const text = parts.join("\n")
  return block.is_error && !/^error/i.test(text) ? `Error: ${text}`.trim() : text
}

function messages(list) {
  const out = []
  for (const m of Array.isArray(list) ? list : []) {
    const blocks = typeof m?.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m?.content) ? m.content : []
    if (m?.role === "assistant") {
      const text = textOf(blocks)
      const calls = blocks
        .filter((b) => b?.type === "tool_use")
        .map((b) => ({ id: String(b.id ?? ""), type: "function", function: { name: String(b.name ?? ""), arguments: JSON.stringify(b.input ?? {}) } }))
      if (!text && !calls.length) continue
      out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) })
      continue
    }
    // Claude Code tells the model of changes mid-conversation as "system"
    if (m?.role === "system") {
      const text = textOf(blocks).trim()
      if (text) out.push({ role: "system", content: text })
      continue
    }
    // a turn's tool results come before what the user wrote after them
    for (const b of blocks) if (b?.type === "tool_result") out.push({ role: "tool", tool_call_id: String(b.tool_use_id ?? ""), content: resultText(b) })
    const parts = []
    for (const b of blocks) {
      if (b?.type === "text" && typeof b.text === "string") parts.push({ type: "text", text: b.text })
      else if (b?.type === "image") parts.push(image(b) ?? { type: "text", text: "[image]" })
      else if (b?.type === "document") parts.push({ type: "text", text: `[document${b.title ? ` ${b.title}` : ""}]` })
    }
    if (parts.length) out.push({ role: "user", content: parts.every((p) => p.type === "text") ? parts.map((p) => p.text).join("\n") : parts })
  }
  return out
}

function effort(body) {
  const asked = String(body.output_config?.effort ?? "").toLowerCase()
  if (asked) return asked === "max" || asked === "xhigh" ? "high" : asked
  const budget = Number(body.thinking?.budget_tokens)
  if (body.thinking?.type !== "enabled" || !(budget > 0)) return undefined
  return budget < 4_000 ? "low" : budget < 16_000 ? "medium" : "high"
}

function toolChoice(choice) {
  if (choice?.type === "any") return "required"
  if (choice?.type === "none") return "none"
  if (choice?.type === "tool" && choice.name) return { type: "function", function: { name: choice.name } }
  return undefined
}

// The request as a chat completions body, and what the answer needs of it.
export function toChat(body) {
  const sys = system(body.system)
  const chat = {
    model: body.model,
    messages: [...(sys ? [{ role: "system", content: sys }] : []), ...messages(body.messages)],
    stream: body.stream === true,
    stream_options: { include_usage: true },
  }
  // tools the client runs: Anthropic's own (web search, …) have no schema,
  // and a deferred one is only a name until the client sends it in full
  const tools = (Array.isArray(body.tools) ? body.tools : []).filter((t) => t?.name && t.input_schema && t.defer_loading !== true)
  if (tools.length) chat.tools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.input_schema } }))
  const choice = toolChoice(body.tool_choice)
  if (choice) chat.tool_choice = choice
  if (body.tool_choice?.disable_parallel_tool_use === true) chat.parallel_tool_calls = false
  const asked = effort(body)
  if (asked) chat.reasoning_effort = asked
  return {
    chat,
    // Claude Code names its session in metadata.user_id
    conversation: typeof body.metadata?.user_id === "string" ? body.metadata.user_id : "",
    model: String(body.model ?? ""),
    thinking: ["enabled", "adaptive"].includes(body.thinking?.type) && body.thinking.display !== "omitted",
  }
}

const usage = (u) => ({ input_tokens: u.input, output_tokens: u.output, cache_creation_input_tokens: 0, cache_read_input_tokens: u.cached })

function parsed(args) {
  try {
    const value = JSON.parse(args)
    return value && typeof value === "object" ? value : {}
  } catch {
    return {}
  }
}

// The chat completions answer as a Messages one.
export async function fromChat(response, req) {
  if (!response.ok) {
    const f = await failure(response)
    return error(f.status, f.message)
  }
  const id = "msg_" + randomUUID().replaceAll("-", "")
  const head = { id, type: "message", role: "assistant", model: req.model }

  if (!req.chat.stream) {
    const res = turnResult(await response.json())
    const content = []
    if (req.thinking && res.reasoning) content.push({ type: "thinking", thinking: res.reasoning, signature: "" })
    if (res.text) content.push({ type: "text", text: res.text })
    for (const c of res.calls) content.push({ type: "tool_use", id: c.id, name: c.name, input: parsed(c.arguments) })
    return Response.json({ ...head, content, stop_reason: res.calls.length ? "tool_use" : "end_turn", stop_sequence: null, usage: usage(res.usage) })
  }

  return eventStream(async (send) => {
    send("message_start", {
      type: "message_start",
      message: { ...head, content: [], stop_reason: null, stop_sequence: null, usage: usage({ input: 0, output: 0, cached: 0 }) },
    })
    send("ping", { type: "ping" })
    let index = -1
    let open = ""
    let calls = 0
    const close = () => {
      if (!open) return
      if (open === "thinking") send("content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "" } })
      send("content_block_stop", { type: "content_block_stop", index })
      open = ""
    }
    const block = (kind, content_block) => {
      if (open === kind && kind !== "tool_use") return
      close()
      open = kind
      send("content_block_start", { type: "content_block_start", index: ++index, content_block })
    }
    for await (const event of turnEvents(response)) {
      if (event.type === "reasoning") {
        if (!req.thinking) continue
        block("thinking", { type: "thinking", thinking: "", signature: "" })
        send("content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: event.text } })
      } else if (event.type === "text") {
        block("text", { type: "text", text: "" })
        send("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: event.text } })
      } else if (event.type === "tool") {
        calls++
        block("tool_use", { type: "tool_use", id: event.call.id, name: event.call.name, input: {} })
        send("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(parsed(event.call.arguments)) } })
      } else if (event.type === "error") {
        close()
        return send("error", { type: "error", error: { type: "api_error", message: event.message } })
      } else if (event.type === "done") {
        close()
        send("message_delta", { type: "message_delta", delta: { stop_reason: calls ? "tool_use" : "end_turn", stop_sequence: null }, usage: usage(event.usage) })
        send("message_stop", { type: "message_stop" })
      }
    }
  })
}

// POST /v1/messages/count_tokens. Amazon Quick counts nothing ahead of a
// turn, so this is an estimate: about four characters a token.
export function countTokens(body) {
  const chars = JSON.stringify([body?.system ?? "", body?.messages ?? [], body?.tools ?? []]).length
  return Response.json({ input_tokens: Math.max(1, Math.ceil(chars / 4)) })
}
