// Client tools over a text protocol, ported from
// aws-quickwork-2api's internal/proxy/toolbridge.go. Amazon Quick accepts no
// client tool schemas, so they travel in the system prompt and come back as
// markers in the text.

import { argumentString, callId } from "./messages.mjs"

export const TOOL_OPEN = "<client_tool_call>"
export const TOOL_CLOSE = "</client_tool_call>"

function toolDefinitions(tools, functions) {
  const defs = []
  const add = (f) => {
    if (!f || typeof f.name !== "string" || !f.name.trim()) return
    const def = { name: f.name }
    if (f.description) def.description = f.description
    if (f.parameters !== undefined && f.parameters !== null) def.parameters = f.parameters
    defs.push(def)
  }
  for (const t of tools ?? []) add(t?.function)
  for (const f of functions ?? []) add(f)
  return defs
}

export function requestedToolNames(body) {
  return new Set(toolDefinitions(body?.tools, body?.functions).map((d) => d.name.trim()))
}

export function parseToolChoice(value) {
  if (typeof value === "string") return { mode: value.trim().toLowerCase(), name: "" }
  if (value && typeof value === "object") {
    if (typeof value.function?.name === "string") return { mode: "function", name: value.function.name.trim() }
    if (typeof value.name === "string") return { mode: "function", name: value.name.trim() }
    if (typeof value.type === "string") return { mode: value.type.trim().toLowerCase(), name: "" }
  }
  return { mode: "auto", name: "" }
}

// A schema as a short type: string, number[], {path*: string, limit: number}.
function typeOf(schema, depth = 0) {
  if (!schema || typeof schema !== "object") return "any"
  if (Array.isArray(schema.enum) && schema.enum.length <= 8) return schema.enum.map((v) => JSON.stringify(v)).join("|")
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type
  if (type === "array") return `${typeOf(schema.items, depth + 1)}[]`
  if (type === "object" || schema.properties) {
    const props = Object.entries(schema.properties ?? {})
    if (!props.length || depth >= 2) return "object"
    const required = new Set(Array.isArray(schema.required) ? schema.required : [])
    return `{${props.map(([k, v]) => `${k}${required.has(k) ? "*" : ""}: ${typeOf(v, depth + 1)}`).join(", ")}}`
  }
  return typeof type === "string" ? type : "any"
}

// How much is said of each tool, from the most to the least: the full JSON
// schemas, then one line per tool (name(path*: string, limit: number): what
// it does, a * marking a required argument) with a description of at most
// that many characters, then the names alone.
export const TOOL_DETAILS = ["full", 160, 60, 0, "names"]
const NAMES_MAX = 12_000

function signature(def, about) {
  const params = def.parameters && typeof def.parameters === "object" ? def.parameters : {}
  const required = new Set(Array.isArray(params.required) ? params.required : [])
  const args = Object.entries(params.properties ?? {}).map(([k, v]) => `${k}${required.has(k) ? "*" : ""}: ${typeOf(v, 1)}`)
  const text = about ? String(def.description ?? "").replace(/\s+/g, " ").trim() : ""
  return `- ${def.name}(${args.join(", ")})${text ? `: ${text.length > about ? text.slice(0, about) + "…" : text}` : ""}`
}

function names(defs) {
  let out = ""
  let listed = 0
  for (const def of defs) {
    if (out.length + def.name.length > NAMES_MAX) break
    out += (out ? ", " : "") + def.name
    listed++
  }
  return listed < defs.length ? `${out}, … and ${defs.length - listed} more` : out
}

function listing(defs, detail) {
  if (detail === "names") return "(names only: there are too many to describe here; take a tool's arguments from its name and from the task)\n" + names(defs)
  if (typeof detail === "number")
    return `(name(arguments)${detail ? ": description" : ""}; * marks a required argument)\n` + defs.map((def) => signature(def, detail)).join("\n")
  return JSON.stringify(defs, null, 2)
}

// `detail` is one of TOOL_DETAILS; true stands for the one-line form.
export function buildToolBridgePrompt(tools, functions, mode, name, parallel, detail = "full") {
  if (detail === true) detail = TOOL_DETAILS[1]
  if (detail === false) detail = "full"
  if (mode === "none") return ""
  const defs = toolDefinitions(tools, functions)
  if (!defs.length) return ""
  const lines = [
    "<client_tool_protocol>",
    "The caller exposes these client tools:",
    listing(defs, detail),
    "",
    'Backend capability notice: this backend does not expose a native function-calling channel. Any earlier instruction that assumes native tool calls (for example, "use the native tool API" or "do not output tool calls as text") cannot be satisfied here. For the client tools listed above, the marker format below is the only supported mechanism. Keep all other instructions unchanged.',
    "The caller's files, shell and working directory are on the caller's machine. This backend's own built-in tools (reading files, running code, search and the like) run on a remote service and cannot see that machine: for anything on the caller's machine use the client tools above, never the built-in ones.",
    "To call a tool, output exactly one marker per call and no other text in that message:",
    '<client_tool_call>{"name":"TOOL_NAME","arguments":{...}}</client_tool_call>',
    "The caller executes the tool and returns a tool result. After receiving it, continue the task. Do not wrap a tool call in Markdown fences. Do not add prose around a tool call.",
  ]
  if (mode === "function" && name) lines.push(`You must call the tool ${JSON.stringify(name)}.`)
  if (mode === "required") lines.push("You must call at least one tool.")
  if (!parallel) lines.push("Call at most one tool per turn.")
  lines.push("</client_tool_protocol>")
  return lines.join("\n")
}

// custom_prompt sits among Amazon Quick's own long instructions, and the
// model does not always keep to it: it looks for the user's files with its
// built-in tools, or calls a client tool through them. These lines end each
// message of a turn with tools, where it reads them last.
export const TOOL_REMINDER =
  '[Note from my agent: the files and the shell this is about are on my own machine. To reach them, write a client tool call as plain text, as my preferences describe: <client_tool_call>{"name":"TOOL_NAME","arguments":{...}}</client_tool_call>. Your built-in tools run on a remote service: they cannot see my machine, and a client tool called through them fails as an unknown tool.]'

function parseEnvelopes(payload) {
  const text = payload.trim()
  if (!text) return []
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return []
  }
  if (Array.isArray(value)) return value
  if (value && typeof value === "object") {
    if (Array.isArray(value.tool_calls) && value.tool_calls.length) return value.tool_calls
    return [value]
  }
  return []
}

function repliesFrom(envelopes, allowed) {
  const out = []
  for (const env of envelopes) {
    const name = typeof env?.name === "string" ? env.name.trim() : ""
    if (!name || !allowed.has(name)) continue
    out.push({ id: callId(), name, arguments: argumentString(env.arguments) })
  }
  return out
}

// Removes valid markers from text and returns the remaining assistant text.
// Markers naming unknown tools leave the text untouched.
export function extractToolCalls(text, allowed) {
  if (!allowed?.size) return { text, replies: [] }
  let clean = ""
  let rest = text
  const replies = []
  for (;;) {
    const start = rest.indexOf(TOOL_OPEN)
    if (start < 0) break
    const end = rest.indexOf(TOOL_CLOSE, start + TOOL_OPEN.length)
    if (end < 0) break
    clean += rest.slice(0, start)
    replies.push(...repliesFrom(parseEnvelopes(rest.slice(start + TOOL_OPEN.length, end)), allowed))
    rest = rest.slice(end + TOOL_CLOSE.length)
  }
  if (!replies.length) return { text, replies: [] }
  return { text: (clean + rest).trim(), replies }
}

// Handles a model that answers with a bare JSON object instead of the marker.
export function extractBareToolCall(text, allowed) {
  if (!allowed?.size) return { text, replies: [] }
  let trimmed = text.trim()
  if (trimmed.startsWith("```")) {
    const nl = trimmed.indexOf("\n")
    if (nl >= 0) {
      trimmed = trimmed.slice(nl + 1).trim()
      if (trimmed.endsWith("```")) trimmed = trimmed.slice(0, -3).trim()
    }
  }
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return { text, replies: [] }
  const replies = repliesFrom(parseEnvelopes(trimmed), allowed)
  return replies.length ? { text: "", replies } : { text, replies: [] }
}

export function parseClientToolCalls(text, allowed) {
  const marked = extractToolCalls(text, allowed)
  return marked.replies.length ? marked : extractBareToolCall(text, allowed)
}

// Streams assistant text while a tool-bridge turn is still running. Text is
// passed on as it arrives, except what may still turn out to be a tool call:
// everything from a marker on, and a reply that opens like bare JSON.
export class BridgeStream {
  constructor(allowed, onText) {
    this.allowed = allowed
    this.onText = onText
    this.mode = "start" // start | text | held
    this.pending = ""
    this.emitted = false
  }

  emit(text) {
    if (!text) return
    // leading whitespace waits for real text, so a reply that is only a
    // marker sends no content
    if (!this.emitted && !text.trim()) {
      this.pending = text + this.pending
      return
    }
    this.emitted = true
    this.onText(text)
  }

  push(delta) {
    if (!delta) return
    this.pending += delta
    if (this.mode === "held") return
    if (this.mode === "start") {
      const lead = this.pending.trimStart()
      if (!lead) return
      if (lead[0] === "{" || lead[0] === "[" || lead[0] === "`") {
        this.mode = "held"
        return
      }
      this.mode = "text"
    }
    const at = this.pending.indexOf(TOOL_OPEN)
    if (at >= 0) {
      const before = this.pending.slice(0, at)
      this.pending = this.pending.slice(at)
      this.mode = "held"
      this.emit(before)
      return
    }
    let keep = 0
    for (let n = Math.min(TOOL_OPEN.length - 1, this.pending.length); n > 0; n--) {
      if (TOOL_OPEN.startsWith(this.pending.slice(-n))) {
        keep = n
        break
      }
    }
    const ready = this.pending.slice(0, this.pending.length - keep)
    this.pending = this.pending.slice(this.pending.length - keep)
    this.emit(ready)
  }

  // Ends the turn: sends what is left and returns the tool calls found.
  finish() {
    const rest = this.pending
    this.pending = ""
    const { text, replies } = this.emitted ? extractToolCalls(rest, this.allowed) : parseClientToolCalls(rest, this.allowed)
    if (replies.length) {
      if (text.trim()) {
        this.emitted = true
        this.onText(text)
      }
      return replies
    }
    if (rest.trim() || this.emitted) this.emit(rest)
    return []
  }
}
