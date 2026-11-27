// C.le.控制台's changes to the bridge (2026-11): attachments counted in a
// message's size, the content filter asked again once only, the usage-limit
// notice in more of its wordings.
import { describe, expect, test } from "bun:test"
import { FILTER_RETRIES, compose, failureResponse, filterStop, limitNotice, prepare, retryable, tryAgain } from "../plugin/chat.mjs"
import { settings } from "../plugin/settings.mjs"
import { UpstreamError, frameBytes, sessionFromAuth, userMessage } from "../plugin/upstream.mjs"

const auth = { quickProvider: "social", idToken: "t", wsHost: "wss://example.test", accountId: "a", tenantUrl: "https://example.test" }
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

// an upload as Amazon Quick answers it: each one adds ~300 bytes to the message
const upload = async (_auth, { name, mimeType, bytes }) => ({
  type: mimeType.startsWith("image/") ? "image" : "file",
  name,
  size: bytes.byteLength,
  mimeType,
  path: `/uploads/threads/0123456789abcdef0123456789abcdef/${name}`,
  attachmentId: "att-" + "0".repeat(60),
  contentSha256: "f".repeat(64),
})

function turnWith(text, images = 0, maxFrameBytes = 8_000) {
  const cfg = settings({ max_frame_bytes: maxFrameBytes })
  const content = [{ type: "text", text }, ...Array.from({ length: images }, () => ({ type: "image_url", image_url: { url: `data:image/png;base64,${png}` } }))]
  const turn = prepare({ model: "smart", messages: [{ role: "user", content: "earlier question" }, { role: "assistant", content: "earlier answer" }, { role: "user", content }] }, cfg)
  return { turn, cfg, session: sessionFromAuth(auth, cfg) }
}

describe("a message's size", () => {
  test("counts its attachments while it is fitted", async () => {
    // text that fits alone, with a few hundred bytes to spare, but not beside
    // eight pictures' entries
    const bare = turnWith("", 0)
    const room = bare.cfg.maxFrameBytes - frameBytes(false, userMessage(bare.session, bare.cfg, (await compose(bare.turn, { auth, cfg: bare.cfg, session: bare.session, thread: null, threadId: "t", upload })).input))
    const { turn, cfg, session } = turnWith("y".repeat(room - 400), 8)
    const { input } = await compose(turn, { auth, cfg, session, thread: null, threadId: "thread-1", upload })
    expect(input.attachments.filter((a) => a.type === "image").length).toBe(8)
    expect(frameBytes(false, userMessage(session, cfg, input))).toBeLessThanOrEqual(cfg.maxFrameBytes)
  })

  test("a message that fits with its pictures is sent whole", async () => {
    const { turn, cfg, session } = turnWith("short question", 2)
    const { input } = await compose(turn, { auth, cfg, session, thread: null, threadId: "thread-2", upload })
    expect(input.attachments.length).toBe(2)
    expect(input.prompt).toContain("short question")
    expect(input.prompt).toContain("earlier answer")
    expect(input.prompt).not.toContain("shortened")
  })
})

describe("the content filter", () => {
  const notice = "That content did not pass our automated check. Try asking again - a small rephrase usually helps."
  const filter = new UpstreamError("blocked", notice)
  const event = new UpstreamError("upstream", "upstream stream_error: content filter")
  const lost = new UpstreamError("transport", "upstream WebSocket read: closed (1006)")

  test("is asked again once only", () => {
    expect(FILTER_RETRIES).toBe(1)
    expect(filterStop(filter)).toBe(true)
    expect(filterStop(event)).toBe(true)
    expect(tryAgain(filter, 0, 0)).toBe(true)
    expect(tryAgain(filter, 1, 1)).toBe(false)
    expect(tryAgain(event, 1, 1)).toBe(false)
    // and is then the filter's 400, which no layer above sends again as it is
    expect(retryable(event)).toBe(false)
    expect(failureResponse(event).status).toBe(400)
    expect(failureResponse(filter).status).toBe(400)
  })

  test("a lost connection or a real block is not the filter", () => {
    expect(filterStop(lost)).toBe(false)
    expect(tryAgain(lost, 1, 1)).toBe(true)
    expect(tryAgain(lost, 4, 0)).toBe(false)
    const policy = new UpstreamError("blocked", "blocked by policy")
    expect(filterStop(policy)).toBe(false)
    expect(tryAgain(policy, 0, 0)).toBe(false)
    expect(filterStop(new UpstreamError("upstream", "content filter quota exceeded"))).toBe(false)
  })
})

describe("the usage-limit notice", () => {
  test("is known in its wordings", () => {
    for (const text of [
      "You've reached your usage limit. Your credits renew on Dec 1.",
      "You’ve reached your session limit.",
      "You have hit your monthly limit for Quick Smart.",
      "You have exceeded your plan's quota.",
      "Usage limit reached. Try again later.",
    ])
      expect(limitNotice(text)).toBe(true)
  })

  test("a reply that only talks of limits is a reply", () => {
    for (const text of [
      "The API allows 10 requests a second; past that rate limit it answers 429.",
      "Set the usage limit in config.yaml before you deploy.",
      "x".repeat(700) + " You've reached your usage limit.",
    ])
      expect(limitNotice(text)).toBe(false)
  })
})
