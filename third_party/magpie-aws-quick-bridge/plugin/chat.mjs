// OpenAI chat completions on top of one Amazon Quick turn, ported from
// aws-quickwork-2api's internal/proxy/server.go. Account rotation and retries
// are magpie's, so a request is tried once and a failure is answered with a
// status magpie can act on.

import { UPSTREAM_PROMPT_OVERRIDE, isSystemMessage, languageNote, lastUserText, promptBlocks, systemText, titleFor, uuid } from "./messages.mjs"
import * as qbs from "./qbs.mjs"
import { ThreadStore, digest, messageKey } from "./threads.mjs"
import { BridgeStream, TOOL_DETAILS, TOOL_REMINDER, ToolCallError, buildToolBridgePrompt, parseClientToolCalls, parseToolChoice, requestedToolNames } from "./toolbridge.mjs"
import { UpstreamError, chat, frameBytes, sessionFromAuth, userMessage } from "./upstream.mjs"
import { isGatewayProvider } from "./wire.mjs"

// "advanced" is listed only for accounts that have it (provider.models).
export const MODES = ["smart", "fast", "balanced", "auto"]
const AGENT_MODES = [...MODES, "advanced"]

// A name may carry a bracketed note that is the agent's own, as Claude
// Code's "[1m]" for a long context: it is not part of the mode.
export function mapModel(model, fallback) {
  let m = String(model ?? "").replace(/\[[^\]]*\]/g, "").trim().toLowerCase()
  m = m.slice(m.lastIndexOf("/") + 1)
  if (m.startsWith("qw-")) m = m.slice(3)
  return AGENT_MODES.includes(m) ? m : fallback
}

// The reasoning effort a request asked for, as Amazon Quick's
// thinking_effort; the option's value when it asked for none.
export function thinkingEffort(body, fallback) {
  const asked = String(body?.reasoning_effort ?? body?.reasoning?.effort ?? "").trim().toLowerCase()
  if (!asked) return fallback
  if (asked === "none" || asked === "off") return "off"
  if (asked === "minimal" || asked === "low") return "low"
  if (asked === "medium") return "medium"
  return "high"
}

export function usageBody(u) {
  const completion = u.completion
  const total = u.total || u.prompt + u.cacheRead + u.cacheWrite + completion
  let prompt = total - completion
  if (prompt < 0) prompt = u.prompt + u.cacheRead + u.cacheWrite
  const out = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total }
  if (u.cacheRead > 0) out.prompt_tokens_details = { cached_tokens: u.cacheRead }
  return out
}

export function errorResponse(status, code, message, headers = {}) {
  return new Response(JSON.stringify({ error: { message, type: code, code } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  })
}

const THROTTLED = /thrott|rate.?limit|too many requests|quota|limit exceeded|capacity/i

// magpie rests an account for a 429's Retry-After. An allowance that is
// away for longer is asked about again after this long, in case the plan
// changed meanwhile.
const REST_MAX_SECS = 6 * 3600

const span = (secs) => (secs >= 5400 ? `${Math.round(secs / 3600)} hours` : `${Math.max(1, Math.round(secs / 60))} minutes`)

// Whether a failed turn is one Amazon Quick refused itself, which it also
// does when an allowance is used up, in words that are not known.
export const refused = (error) => error instanceof UpstreamError && (error.kind === "upstream" || (error.kind === "handshake" && error.status === 429))

// A failure that the same request, sent again a moment later, is likely to
// get past: the connection could not be made or was lost, Amazon Quick took
// too long, or the model wrote a tool call that could not be read. It is
// answered as "overloaded" (503 with Retry-After, 529 on the Anthropic
// route), which agents retry by themselves, rather than as a failure that
// ends their turn.
export function retryable(error) {
  if (error instanceof ToolCallError) return true
  if (!(error instanceof UpstreamError)) return false
  if (error.kind === "transport" || error.kind === "timeout" || error.kind === "empty") return true
  // an error event of Amazon Quick's own, other than a limit it sets
  if (error.kind === "upstream") return !THROTTLED.test(error.message)
  return error.kind === "handshake" && (error.status === 0 || error.status >= 500)
}

// Dial failures are tried again here first, after these pauses: they were
// seen to come in runs of a few seconds to a few minutes.
const DIAL_RETRY_MS = [1_000, 2_000, 4_000, 8_000]
const pause = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)), { once: true })
  })

// The answer for a turn that failed before anything was sent. `spent` is
// the account's used-up allowance (qbs.spentAllowance), when it has one.
export function failureResponse(error, spent = null) {
  if (spent && refused(error)) {
    const back = spent.secs > 0 ? `; it is back in ${span(spent.secs)}` : ""
    return errorResponse(429, "rate_limit_exceeded", `Amazon Quick's ${spent.name} allowance is used up${back} (${error.message})`, {
      ...(spent.secs > 0 ? { "retry-after": String(Math.min(spent.secs, REST_MAX_SECS)) } : {}),
    })
  }
  if (retryable(error)) return errorResponse(503, "overloaded", String(error?.message ?? error), { "retry-after": "2" })
  if (!(error instanceof UpstreamError)) return errorResponse(502, "upstream_error", String(error?.message ?? error))
  if (error.kind === "handshake" && error.status === 401)
    return errorResponse(401, "upstream_session_unavailable", `Amazon Quick refused the sign-in; sign in again (${error.message})`, {
      "x-magpie-sign-in": "expired",
    })
  if (error.kind === "handshake" && error.status === 403) return errorResponse(403, "upstream_forbidden", error.message)
  if (error.kind === "handshake" && error.status === 429) return errorResponse(429, "rate_limit_exceeded", error.message)
  if (error.kind === "timeout") return errorResponse(504, "upstream_timeout", error.message)
  if (error.kind === "too_large")
    return errorResponse(400, "context_length_exceeded", `the request does not fit Amazon Quick's 64 KB message limit (${error.message})`)
  if (error.kind === "blocked") return errorResponse(400, "content_filter", error.message)
  if (error.kind === "upstream" && THROTTLED.test(error.message)) return errorResponse(429, "rate_limit_exceeded", error.message)
  return errorResponse(502, "upstream_error", error.message)
}

const wireToolCall = (r, index) => ({
  ...(index === undefined ? {} : { index }),
  id: r.id,
  type: "function",
  function: { name: r.name, arguments: r.arguments },
})

// Reads a chat completions body into what one upstream turn needs. `input`
// is the turn as a new thread would get it, before it is fitted to a frame.
export function prepare(body, cfg, threadId) {
  if (!body || typeof body !== "object") throw new Error("the request body is not a JSON object")
  if (Number(body.n) > 1) throw new Error("n > 1 is not supported")
  const messages = Array.isArray(body.messages) ? body.messages : []
  const convo = messages.filter((m) => !isSystemMessage(m))
  const prompt = promptBlocks(messages).join("\n\n")
  const allowed = requestedToolNames(body)
  const choice = parseToolChoice(body.tool_choice ?? body.function_call)
  if (choice.mode === "function" && choice.name) allowed.add(choice.name)
  const parallel = body.parallel_tool_calls !== false
  // with tools, the language the user writes in is named: the tools' arguments
  // are then the user's own words, not a translation of them
  const language = languageNote(convo)
  const said = new Map()
  const tools = (detail) => {
    if (said.has(detail)) return said.get(detail)
    const prompt = buildToolBridgePrompt(body.tools, body.functions, choice.mode, choice.name, parallel, detail)
    said.set(detail, prompt && language ? prompt + "\n\n" + language : prompt)
    return said.get(detail)
  }
  const bridgePrompt = tools("full")
  const system = systemText(messages)
  const custom = (toolsPrompt) => [system, UPSTREAM_PROMPT_OVERRIDE, toolsPrompt].filter(Boolean).join("\n\n")
  const model = mapModel(body.model, cfg.defaultModel)
  return {
    model,
    allowed,
    choice,
    parallel,
    bridge: bridgePrompt !== "",
    bridgeAllowed: choice.mode === "function" && choice.name ? new Set([choice.name]) : allowed,
    stream: body.stream === true,
    includeUsage: body.stream_options?.include_usage === true,
    convo,
    system,
    custom,
    tools: (detail) => (bridgePrompt ? tools(detail) : ""),
    input: {
      prompt,
      model,
      threadId,
      title: titleFor(lastUserText(messages)),
      systemPrompt: custom(bridgePrompt),
      reminder: bridgePrompt ? TOOL_REMINDER : "",
      thinkingEffort: thinkingEffort(body, cfg.thinkingEffort),
      webSearch: typeof body.web_search_enabled === "boolean" ? body.web_search_enabled : cfg.webSearch === true,
    },
  }
}

const threads = new ThreadStore()

function middleCut(text, keep) {
  if (text.length <= keep) return text
  const note = "\n…[shortened to fit Amazon Quick's 64 KB message limit]…\n"
  const half = Math.max(0, Math.floor((keep - note.length) / 2))
  return text.slice(0, half) + note + text.slice(text.length - half)
}

// The longest cut of `text` (by middleCut) for which fits(cut) holds.
function longestFit(text, fits) {
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (fits(middleCut(text, mid))) low = mid
    else high = mid - 1
  }
  return middleCut(text, low)
}

// What is sent for a turn: for a new thread the whole conversation, for a
// continued one (`thread`) the messages that are new. It is made to fit one
// message: the tools are described more briefly, then the instructions are
// shortened, then what is too long goes into an attachment the model is told
// to read, and where that cannot be done the oldest parts are cut.
export async function compose(turn, { auth, cfg, session, thread, threadId, signal, upload = qbs.upload }) {
  const gateway = isGatewayProvider(session.provider)
  const images = []
  const fresh = turn.convo.slice(thread ? thread.keys.length : 0)
  let blocks = promptBlocks(fresh, { all: turn.convo, images: cfg.attachments && !gateway ? images : undefined })
  const input = { ...turn.input, threadId, resume: !!thread, prompt: blocks.join("\n\n") }
  const limit = cfg.maxFrameBytes
  const size = () => frameBytes(gateway, userMessage(session, cfg, input))
  const fits = () => !limit || size() <= limit

  // the thread keeps the instructions it was given, in the form that
  // fitted: they go again only when the caller's own changed
  const asked = digest(turn.input.systemPrompt)
  if (thread && thread.custom === asked) input.systemPrompt = ""
  const instructed = input.systemPrompt !== ""
  if (!fits() && instructed) {
    // a short message is sent whole beside the instructions; a long one
    // gives way, and the instructions may take half of what can be sent
    const prompt = input.prompt
    input.systemPrompt = ""
    const short = size() <= limit / 2
    if (!short) input.prompt = ""
    const bare = size()
    const room = short ? limit : limit / 2
    const set = (system, detail) => ((input.systemPrompt = [system, UPSTREAM_PROMPT_OVERRIDE, turn.tools(detail)].filter(Boolean).join("\n\n")), size())
    // the tools said as fully as leaves the caller's instructions whole, or
    // as takes half of the room at most, the instructions then shortened
    // into the rest
    const whole = (detail) => set(turn.system, detail) <= room
    const detail = TOOL_DETAILS.find((d) => whole(d) || set("", d) - bare <= (room - bare) / 2) ?? TOOL_DETAILS.at(-1)
    if (!whole(detail)) set(longestFit(turn.system, (cut) => set(cut, detail) <= room), detail)
    input.prompt = prompt
  }

  const attachments = []
  const attach = async (name, mimeType, bytes) => attachments.push(await upload(auth, { name, mimeType, bytes, threadId }, { signal }))
  if (!fits() && cfg.attachments && !gateway) {
    // the newest message stays in the frame when it is short
    const last = blocks.length > 1 && blocks.at(-1).length <= 6000 ? blocks.at(-1) : ""
    const long = (last ? blocks.slice(0, -1) : blocks).join("\n\n")
    const name = `context_${uuid().slice(0, 8)}.txt`
    const bytes = new TextEncoder().encode(long)
    try {
      await attach(name, "text/plain", bytes)
      input.prompt =
        `${last ? "The conversation up to the last message" : "This message"} is in the attached file ${name} (${bytes.byteLength} bytes) because it is too long to send here. ` +
        "Read the whole file with your file tool before anything else, then carry on from it exactly as if its text had been sent in this message. Do not mention the file or that you are reading it." +
        (last ? "\n\n" + last : "")
      blocks = [input.prompt]
    } catch (e) {
      if (signal?.aborted) throw e
    }
  }
  if (!fits()) {
    const set = () => ((input.prompt = blocks.join("\n\n")), fits())
    for (let i = 0; i < blocks.length - 1 && !set(); i++) blocks[i] = middleCut(blocks[i], 1500)
    while (blocks.length > 1 && !set()) blocks.shift()
    if (!set()) blocks[0] = longestFit(blocks[0], (cut) => ((blocks[0] = cut), set()))
    set()
  }
  // the newest ten: a picture just read matters more than old ones
  for (const image of images.slice(-10)) {
    try {
      await attach(image.name, image.mimeType, Buffer.from(image.base64, "base64"))
    } catch (e) {
      if (signal?.aborted) throw e
    }
  }
  if (attachments.length) input.attachments = attachments
  if (!fits()) throw new UpstreamError("too_large", `${size()} bytes after shortening, over ${limit}`)
  return { input, custom: instructed ? asked : thread?.custom ?? "" }
}

// Amazon Quick's content filter sometimes ends a reply with its notice as
// the reply's own text rather than as an error. Asked again, the same turn
// usually passes, so it is treated as a failure worth retrying.
const FILTER_NOTICE = /did not pass our automated check|content filter stopped this reply/i
export const filterNotice = (text) => text.trim().length < 400 && FILTER_NOTICE.test(text)

// Worth asking again here, on a new thread: what retryable says, and the
// content filter's notice when it comes as a guardrail event ("did not pass
// our automated check"), which passes on a second try as often as the notice
// as text does. Should every try be stopped, it is still answered as the
// guardrail's 400, not as "overloaded": the agent would only ask again.
const askAgain = (error) => retryable(error) || (error instanceof UpstreamError && error.kind === "blocked" && filterNotice(error.message))

// Amazon Quick's answer on a used-up allowance, given as the reply's text
// ("You've reached your usage limit…"). The sidecar checks the allowance
// first, but an allowance used up since it last looked still gets this far:
// it is answered as a refusal (429), never as the model's reply.
const LIMIT_NOTICE = /you(?:'|’)?ve reached your (?:usage|session|monthly|daily) limit|reached (?:your|the) (?:usage|session) limit/i
export const limitNotice = (text) => text.trim().length < 600 && LIMIT_NOTICE.test(text)

function filtered(text, calls) {
  if (!calls.length && limitNotice(text)) throw new UpstreamError("handshake", `Amazon Quick: ${text.trim()}`, 429)
  if (!calls.length && filterNotice(text)) throw new UpstreamError("upstream", `content filter: ${text.trim()}`)
}

async function complete(turn, run) {
  let reasoning = ""
  const res = await run((event) => {
    if (event.type === "reasoning") reasoning += event.text
  })
  let text = res.text
  let calls = []
  try {
    if (turn.bridge) {
      ;({ text, replies: calls } = parseClientToolCalls(text, turn.bridgeAllowed))
      if (!turn.parallel) calls = calls.slice(0, 1)
    }
    if (!text.trim() && !calls.length) throw new UpstreamError("empty", "upstream returned no text or tool calls")
    filtered(text, calls)
  } catch (e) {
    // the thread holds the reply that failed: it is not continued
    threads.drop({ id: res.threadId })
    throw e
  }
  const message = { role: "assistant", content: text.trim() ? text : null }
  if (reasoning) message.reasoning_content = reasoning
  if (calls.length) message.tool_calls = calls.map((c) => wireToolCall(c))
  return Response.json({
    id: turn.id,
    object: "chat.completion",
    created: turn.created,
    model: turn.model,
    choices: [{ index: 0, message, finish_reason: calls.length ? "tool_calls" : "stop" }],
    usage: usageBody(res.usage),
  })
}

// How many times a streamed turn is asked again, on a new thread, when it
// fails in a way worth retrying after its stream has started.
// The content filter was seen to stop the same turn two or three times in a
// row before letting it through; each stop comes within seconds.
const STREAM_RETRIES = 4

// A line on stderr (the gateway's log) for what happens inside a stream,
// where no status is left to tell it.
const note = (line) => {
  try {
    process.stderr.write(`${new Date().toISOString()} ${line}\n`)
  } catch {}
}

// Streams a turn as SSE. The Response is returned once the first chunk is
// ready, so a turn that fails before that is still answered with a status
// (and magpie can move on to another account). A turn that has written
// nothing after `headerWaitMs` is answered then, with an open stream: the
// refusals come within seconds, and an agent left without an answer for
// minutes gives the request up.
//
// With client tools (an agent's turn), the reply's text is held until the
// turn is complete, the thinking still streaming as it comes. A turn that
// fails partway (the content filter, a lost connection) is then asked again
// by `again()` on a new thread, unseen by the client: once a stream has
// started, an agent takes an error in it as the end of its turn.
function stream(turn, run, abort, headerWaitMs = 0, again = null) {
  const encoder = new TextEncoder()
  let controller
  let started = false
  let closed = false
  let first
  const ready = new Promise((resolve, reject) => (first = { resolve, reject }))
  const body = new ReadableStream({
    start(c) {
      controller = c
    },
    cancel() {
      closed = true
      abort.abort()
    },
  })
  const raw = (payload) => {
    if (closed) return
    controller.enqueue(encoder.encode(typeof payload === "string" ? payload : `data: ${JSON.stringify(payload)}\n\n`))
  }
  const base = () => ({ id: turn.id, object: "chat.completion.chunk", created: turn.created, model: turn.model })
  const start = () => {
    if (started) return
    started = true
    clearTimeout(waiting)
    raw({ ...base(), choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })
    first.resolve()
  }
  const waiting = headerWaitMs > 0 ? setTimeout(start, headerWaitMs) : null
  const chunk = (delta, finish = null, extra = {}) => {
    start()
    raw({ ...base(), choices: [{ index: 0, delta, finish_reason: finish }], ...extra })
  }
  const end = () => {
    raw("data: [DONE]\n\n")
    if (!closed) controller.close()
    closed = true
  }

  const hold = turn.bridge
  const once = async (run) => {
    let sawText = false
    let held = ""
    const text = (t) => {
      sawText = true
      if (hold) held += t
      else chunk({ content: t })
    }
    const bridge = turn.bridge ? new BridgeStream(turn.bridgeAllowed, text) : null
    let res
    try {
      res = await run((event) => {
        if (!event.text) return
        if (event.type === "reasoning") return chunk({ reasoning_content: event.text })
        if (event.type !== "text") return
        if (bridge) bridge.push(event.text)
        else text(event.text)
      })
      let calls = bridge ? bridge.finish() : []
      if (!turn.parallel) calls = calls.slice(0, 1)
      if (!sawText && !calls.length) throw new UpstreamError("empty", "upstream returned no text or tool calls")
      if (hold) filtered(held, calls)
      if (held) chunk({ content: held })
      calls.forEach((c, i) => chunk({ tool_calls: [wireToolCall(c, i)] }))
      chunk({}, calls.length ? "tool_calls" : "stop")
      if (turn.includeUsage) {
        raw({ id: turn.id, object: "chat.completion.chunk", created: turn.created, model: turn.model, choices: [], usage: usageBody(res.usage) })
      }
      end()
    } catch (error) {
      // the thread holds the reply that failed: it is not continued
      if (res?.threadId) threads.drop({ id: res.threadId })
      error.shown = sawText && !hold
      throw error
    }
  }

  ;(async () => {
    let current = run
    for (let tries = 0; ; tries++) {
      try {
        return await once(current)
      } catch (error) {
        const worth = again && askAgain(error) && !error.shown && tries < STREAM_RETRIES && !closed && !abort.signal.aborted
        const why = String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 200)
        if (!closed && !abort.signal.aborted) note(`stream ${worth ? `retry ${tries + 1}` : "failed"}: ${why}`)
        if (worth) {
          try {
            current = await again()
            if (started) chunk({ reasoning_content: `\n[the reply did not come through (${error instanceof UpstreamError ? error.kind : "tool call"}); asking again]\n` })
            continue
          } catch (next) {
            error = next
          }
        }
        clearTimeout(waiting)
        if (!started) return first.reject(error)
        const code = retryable(error) ? "overloaded" : error instanceof UpstreamError && error.kind === "handshake" && error.status === 429 ? "rate_limit_exceeded" : "upstream_error"
        raw({ error: { message: String(error?.message ?? error), type: code, code } })
        return end()
      }
    }
  })()

  return ready.then(
    () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no" },
      }),
  )
}

// Answers one POST /chat/completions for the account `auth`. `conversation`
// is the caller's id for the conversation, when it gives one: requests of
// different conversations never share a thread.
export async function chatCompletions({ body, auth, cfg, signal, conversation = "" }) {
  let turn
  try {
    turn = prepare(body, cfg)
    if (!turn.convo.length) throw new Error("messages must not be empty")
  } catch (e) {
    return errorResponse(400, "invalid_request_error", e.message)
  }
  turn.id = "chatcmpl-" + uuid().replaceAll("-", "")
  turn.created = Math.floor(Date.now() / 1000)

  const abort = new AbortController()
  const onAbort = () => abort.abort(signal.reason)
  if (signal?.aborted) onAbort()
  else signal?.addEventListener("abort", onAbort, { once: true })
  const settle = () => signal?.removeEventListener("abort", onAbort)

  const session = sessionFromAuth(auth, cfg)
  // a Gateway tenant's chat is dialed at its cell, and at the tenant itself
  // when the cell is not known or does not take the connection
  const tenantHost = session.wsHost
  if (isGatewayProvider(session.provider)) session.wsHost = (await qbs.cellHost(auth, abort.signal).catch(() => "")) || tenantHost
  const dial = (input, onEvent) =>
    chat({ session, cfg, input, signal: abort.signal, onEvent }).catch((e) => {
      const refusedDial = e instanceof UpstreamError && e.kind === "handshake" && e.status !== 401 && e.status !== 403
      if (session.wsHost === tenantHost || !refusedDial || abort.signal.aborted) throw e
      qbs.forgetCell(auth)
      session.wsHost = tenantHost
      return chat({ session, cfg, input, signal: abort.signal, onEvent })
    })
  // a connection that could not be made is made again before the caller
  // hears of it; nothing reached Amazon Quick, so nothing is sent twice
  const send = async (input, onEvent) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await dial(input, onEvent)
      } catch (e) {
        if (!(e?.dial && retryable(e)) || attempt >= DIAL_RETRY_MS.length || abort.signal.aborted) throw e
        await pause(DIAL_RETRY_MS[attempt], abort.signal)
      }
    }
  }
  const account = `${auth?.tenantUrl}|${auth?.accountId}`
  const keys = turn.convo.map(messageKey)
  // The turn, ready to run on `thread` (null: a new one).
  const runFor = async (thread) => {
    const threadId = thread?.id ?? uuid()
    let composed
    try {
      composed = await compose(turn, { auth, cfg, session, thread, threadId, signal: abort.signal })
    } catch (e) {
      threads.drop(thread)
      throw e
    }
    const run = async (onEvent) => {
      try {
        const res = await send(composed.input, onEvent).catch(async (e) => {
          // refused as too large although it was measured to fit: nothing
          // was taken, so it is sent once more, made smaller
          if (!(e instanceof UpstreamError) || e.kind !== "too_large" || !cfg.maxFrameBytes) throw e
          const smaller = { ...cfg, maxFrameBytes: Math.floor(cfg.maxFrameBytes * 0.7) }
          composed = await compose(turn, { auth, cfg: smaller, session, thread, threadId, signal: abort.signal })
          return send(composed.input, onEvent)
        })
        if (cfg.stateful) threads.commit({ id: threadId, account, session: conversation, custom: composed.custom }, keys)
        return { ...res, threadId }
      } catch (e) {
        threads.drop(thread)
        throw e
      }
    }
    return run
  }
  const attempt = async (thread) => {
    const run = await runFor(thread)
    if (turn.stream) {
      const answer = await stream(turn, run, abort, cfg.headerWaitMs, () => runFor(null))
      settle()
      return answer
    }
    // a whole answer is asked again the same way, on a new thread
    for (let tries = 0, current = run; ; tries++) {
      try {
        const answer = await complete(turn, current)
        settle()
        return answer
      } catch (e) {
        if (!askAgain(e) || tries >= STREAM_RETRIES || abort.signal.aborted) throw e
        current = await runFor(null)
      }
    }
  }

  const thread = cfg.stateful ? threads.match(account, conversation, keys) : null
  try {
    try {
      return await attempt(thread)
    } catch (e) {
      // a thread Amazon Quick no longer takes: the conversation starts a
      // new one, sent whole
      if (!thread || signal?.aborted || (e instanceof UpstreamError && e.kind === "handshake")) throw e
      return await attempt(null)
    }
  } catch (e) {
    settle()
    if (signal?.aborted) throw e
    return failureResponse(e, refused(e) ? await qbs.spent(auth) : null)
  }
}
