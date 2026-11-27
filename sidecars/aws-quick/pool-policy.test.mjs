// node --test sidecars/aws-quick/pool-policy.test.mjs
import assert from "node:assert/strict"
import { test } from "node:test"
import { REST_FIRST_SECS, REST_MAX_SECS, backoffSecs, conversationKey, fingerprint, restFor } from "./pool-policy.mjs"

const headers = (h = {}) => new Headers(h)
const turn = (...more) => ({ system: "You are Claude Code.", messages: [{ role: "user", content: "fix the build" }, ...more] })

test("a conversation is kept by its header first", () => {
  assert.equal(conversationKey(headers({ "x-aws-quick-conversation": "sess-1" }), { metadata: { user_id: "u" } }), "sess-1")
  assert.equal(conversationKey(headers(), { metadata: { user_id: "user_abc_session_1" } }), "user_abc_session_1")
  assert.equal(conversationKey(headers({ session_id: "codex-1" }), {}), "codex-1")
})

test("the API's guessed msg: id gives way to the fingerprint, which holds after the first reply", () => {
  const before = conversationKey(headers({ "x-aws-quick-conversation": "msg:00000000000000aa" }), turn())
  const after = conversationKey(headers({ "x-aws-quick-conversation": "msg:00000000000000bb" }), turn({ role: "assistant", content: "done" }, { role: "user", content: "next" }))
  assert.equal(before, after)
  assert.equal(before, fingerprint(turn()))
  // a real session id from the client is kept
  assert.equal(conversationKey(headers({ "x-aws-quick-conversation": "8f1c2d3e-session" }), turn()), "8f1c2d3e-session")
  assert.equal(conversationKey(headers({ "x-aws-quick-conversation": "msg-board" }), turn()), "msg-board")
})

test("without a name, a conversation is known by how it began", () => {
  const first = conversationKey(headers(), turn())
  const later = conversationKey(headers(), turn({ role: "assistant", content: "done" }, { role: "user", content: "now test it" }))
  assert.match(first, /^fp:/)
  assert.equal(first, later, "the same conversation, three turns on, stays on its account")
  assert.equal(fingerprint({ input: "fix the build", instructions: "x" }), fingerprint({ input: [{ role: "user", content: "fix the build" }], instructions: "x" }))
  // an agent that rewrites its instructions between turns (Metre does) keeps its account
  const rewritten = { ...turn({ role: "assistant", content: "done" }, { role: "user", content: "next" }), system: "You are Claude Code. Last turn changed a.txt." }
  assert.equal(conversationKey(headers(), rewritten), first)
  assert.equal(conversationKey(headers(), { messages: [{ role: "system", content: "v2" }, { role: "user", content: "fix the build" }] }), first)
})

test("different conversations, or none, are not taken for one", () => {
  const a = conversationKey(headers(), turn())
  const b = conversationKey(headers(), { system: "You are Claude Code.", messages: [{ role: "user", content: "write the docs" }] })
  const c = conversationKey(headers(), { system: "Another agent.", messages: [{ role: "user", content: "fix the build, then the tests" }] })
  assert.notEqual(a, b)
  assert.notEqual(a, c)
  assert.equal(conversationKey(headers(), null), "")
  assert.equal(conversationKey(headers(), { messages: [] }), "")
  assert.equal(conversationKey(headers({ "x-aws-quick-conversation": "  " }), null), "")
})

test("an account that gives no Retry-After rests 10 minutes, doubling up to six hours", () => {
  assert.equal(backoffSecs(0), REST_FIRST_SECS)
  assert.equal(REST_FIRST_SECS, 600)
  let strikes = 0
  const rests = []
  for (let i = 0; i < 8; i++) {
    const next = restFor(429, null, strikes)
    rests.push(next.secs)
    strikes = next.strikes
  }
  assert.deepEqual(rests, [600, 1200, 2400, 4800, 9600, 19200, 21600, 21600])
  assert.equal(REST_MAX_SECS, 21600)
})

test("a Retry-After is kept, and is never six hours by default", () => {
  assert.deepEqual(restFor(429, "90", 3), { secs: 90, strikes: 0 })
  assert.deepEqual(restFor(429, "99999", 0), { secs: REST_MAX_SECS, strikes: 0 })
  assert.deepEqual(restFor(401, null, 2), { secs: 1800, strikes: 2 })
  assert.notEqual(restFor(429, "", 0).secs, REST_MAX_SECS)
  assert.notEqual(restFor(429, "garbage", 0).secs, REST_MAX_SECS)
})
