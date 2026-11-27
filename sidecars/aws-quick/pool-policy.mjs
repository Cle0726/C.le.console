// SPDX-License-Identifier: GPL-3.0-only
// How the pool (cle-aws-quick multi) keeps a conversation on one account and
// how long an account that refused a turn rests. Kept apart from entry.mjs,
// which runs as soon as it is loaded, so the rules can be tested.

import { createHash } from "node:crypto"

// The header a client (or the console's API, which fills it with its own
// conversation id) names the conversation by.
export const CONVERSATION_HEADER = "x-aws-quick-conversation"

// An account told nothing about when it is back rests 10 minutes, then twice
// as long each time it is still refused, up to six hours.
export const REST_FIRST_SECS = 600
export const REST_MAX_SECS = 6 * 3600

export function backoffSecs(strikes) {
  const n = Math.max(0, Math.floor(Number(strikes) || 0))
  return Math.min(REST_FIRST_SECS * 2 ** Math.min(n, 16), REST_MAX_SECS)
}

// How long an account rests after a refused turn and the strikes it then has:
// the Retry-After it gave, else the back-off for its strikes so far.
export function restFor(status, retryAfter, strikes = 0) {
  if (status === 401) return { secs: 1800, strikes }
  const said = Number(retryAfter)
  if (Number.isFinite(said) && said > 0) return { secs: Math.min(Math.ceil(said), REST_MAX_SECS), strikes: 0 }
  return { secs: backoffSecs(strikes), strikes: strikes + 1 }
}

const text = (value) => (typeof value === "string" ? value : value === undefined || value === null ? "" : JSON.stringify(value))
const role = (m) => String(m?.role ?? "").toLowerCase()

// What a conversation keeps from its first turn on: its first user message
// (Anthropic Messages, Chat Completions or Responses). Not its instructions:
// agents rewrite those between turns (碧琪's Metre adds what the last turn
// did, seen 2026-11-27), which moved a conversation to another account on
// every turn. Two conversations that open with the very same message share
// an account, which costs nothing.
export function fingerprint(body) {
  if (!body || typeof body !== "object") return ""
  const list = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : typeof body.input === "string" ? [{ role: "user", content: body.input }] : []
  const first = list.find((m) => role(m) === "user" || (!m?.role && m?.content !== undefined))
  if (!first) return ""
  return "fp:" + createHash("sha256").update(text(first.content)).digest("hex").slice(0, 32)
}

// The conversation a turn belongs to: the header first, then what the body
// names it by, then its fingerprint; "" for a request that has none.
//
// A header of the form msg:<hex> is the console API's own guess, made when the
// client names no session: a hash of the instructions, the first user message
// and the first reply, which changes once the first reply is in. The
// fingerprint, which does not, stands in for it.
const GUESSED = /^msg:[0-9a-f]+$/i

export function conversationKey(headers, body) {
  const named = String(headers?.get?.(CONVERSATION_HEADER) ?? "").trim()
  if (named && !GUESSED.test(named)) return named.slice(0, 256)
  const said = body?.metadata?.user_id ?? body?.user ?? body?.prompt_cache_key ?? headers?.get?.("session_id") ?? ""
  if (String(said).trim()) return String(said).trim().slice(0, 256)
  return fingerprint(body)
}
