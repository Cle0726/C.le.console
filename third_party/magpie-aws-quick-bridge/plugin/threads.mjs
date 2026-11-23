// Which Amazon Quick thread a request continues.
//
// Agents send the whole conversation with every request, but a frame holds
// 64 KB and Amazon Quick keeps each thread's history itself. So a request
// whose messages begin with those of a thread answered here before is sent
// to that thread as only the messages that are new.

import { createHash } from "node:crypto"
import { contentText } from "./messages.mjs"

const MAX_THREADS = 300
const TTL_MS = 6 * 3600_000

// The headers a client names its conversation in: magpie's own two, Codex's,
// and the ones other OpenAI clients send for session affinity. A header that
// changes with every request is not among them: it would give each request
// a thread of its own.
const CONVERSATION_HEADERS = ["x-aws-quick-conversation", "x-magpie-session", "session_id", "session-id", "x-session-id", "x-session-affinity", "x-thread-id", "x-conversation-id", "conversation_id"]

// The caller's id for the conversation a request belongs to, "" when its
// headers name none.
export function conversationOf(headers) {
  for (const name of CONVERSATION_HEADERS) {
    const value = String(headers?.get?.(name) ?? "").trim()
    if (value) return value.slice(0, 256)
  }
  return ""
}

export const digest = (text) => createHash("sha256").update(String(text)).digest("hex").slice(0, 24)

const roleOf = (m) => String(m?.role ?? "user").trim().toLowerCase() || "user"

// What identifies a message when a later request repeats it. An assistant
// message is compared by its role alone: clients send back the reply they
// were given in their own shape (trimmed, split into parts, re-serialized).
export function messageKey(m) {
  const role = roleOf(m)
  if (role === "assistant") return "assistant"
  return `${role}:${digest(`${m?.tool_call_id ?? ""}\n${m?.name ?? ""}\n${contentText(m?.content)}`)}`
}

export class ThreadStore {
  constructor() {
    this.threads = new Map()
  }

  // The thread `keys` (a request's messages, system ones left out) goes on
  // from, and how many of them it already has. A thread is taken while its
  // turn runs, so two requests never write to one thread at once.
  match(account, session, keys) {
    const now = Date.now()
    let best = null
    for (const [id, t] of this.threads) {
      if (now - t.at > TTL_MS) {
        this.threads.delete(id)
        continue
      }
      if (t.busy || t.account !== account || t.session !== session) continue
      if (t.keys.length >= keys.length || (best && t.keys.length <= best.keys.length)) continue
      if (t.keys.every((k, i) => k === keys[i])) best = t
    }
    // what is new must be the caller's turn, not a reply written elsewhere
    if (!best || keys.slice(best.keys.length).includes("assistant")) return null
    best.busy = true
    return best
  }

  // Records the thread after a turn: the messages it now holds, the reply
  // included.
  commit(thread, keys) {
    this.threads.delete(thread.id)
    while (this.threads.size >= MAX_THREADS) this.threads.delete(this.threads.keys().next().value)
    this.threads.set(thread.id, { ...thread, keys: [...keys, "assistant"], busy: false, at: Date.now() })
  }

  drop(thread) {
    if (thread?.id) this.threads.delete(thread.id)
  }
}
