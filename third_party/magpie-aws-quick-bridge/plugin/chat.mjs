// OpenAI chat completions on top of one Amazon Quick turn, ported from
// aws-quickwork-2api's internal/proxy/server.go. Account rotation and retries
// are magpie's, so a request is tried once and a failure is answered with a
// status magpie can act on.

import { UPSTREAM_PROMPT_OVERRIDE, isSystemMessage, languageNote, lastUserText, promptBlocks, systemText, titleFor, uuid } from "./messages.mjs"
import * as qbs from "./qbs.mjs"
import { ThreadStore, digest, messageKey } from "./threads.mjs"
import { BridgeStream, TOOL_DETAILS, TOOL_REMINDER, buildToolBridgePrompt, parseClientToolCalls, parseToolChoice, requestedToolNames } from "./toolbridge.mjs"
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

// The answer for a turn that failed before anything was sent. `spent` is
// the account's used-up allowance (qbs.spentAllowance), when it has one.
export function failureResponse(error, spent = null) {
  if (spent && refused(error)) {
    const back = spent.secs > 0 ? `; it is back in ${span(spent.secs)}` : ""
    return errorResponse(429, "rate_limit_exceeded", `Amazon Quick's ${spent.name} allowance is used up${back} (${error.message})`, {
      ...(spent.secs > 0 ? { "retry-after": String(Math.min(spent.secs, REST_MAX_SECS)) } : {}),
    })
  }
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
  for (const image of images.slice(0, 10)) {
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

async function complete(turn, run) {
  let reasoning = ""
  const res = await run((event) => {
    if (event.type === "reasoning") reasoning += event.text
  })
  let text = res.text
  let calls = []
  if (turn.bridge) {
    ;({ text, replies: calls } = parseClientToolCalls(text, turn.bridgeAllowed))
    if (!turn.parallel) calls = calls.slice(0, 1)
  }
  if (!text.trim() && !calls.length) return errorResponse(502, "upstream_error", "upstream returned no text or tool calls")
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

// Streams a turn as SSE. The Response is returned once the first chunk is
// ready, so a turn that fails before that is still answered with a status
// (and magpie can move on to another account). A turn that has written
// nothing after `headerWaitMs` is answered then, with an open stream: the
// refusals come within seconds, and an agent left without an answer for
// minutes gives the request up.
function stream(turn, run, abort, headerWaitMs = 0) {
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

  let sawText = false
  const text = (t) => {
    sawText = true
    chunk({ content: t })
  }
  const bridge = turn.bridge ? new BridgeStream(turn.bridgeAllowed, text) : null

  run((event) => {
    if (!event.text) return
    if (event.type === "reasoning") return chunk({ reasoning_content: event.text })
    if (event.type !== "text") return
    if (bridge) bridge.push(event.text)
    else text(event.text)
  })
    .then((res) => {
      let calls = bridge ? bridge.finish() : []
      if (!turn.parallel) calls = calls.slice(0, 1)
      if (!sawText && !calls.length) throw new UpstreamError("upstream", "upstream returned no text or tool calls")
      calls.forEach((c, i) => chunk({ tool_calls: [wireToolCall(c, i)] }))
      chunk({}, calls.length ? "tool_calls" : "stop")
      if (turn.includeUsage) {
        raw({ id: turn.id, object: "chat.completion.chunk", created: turn.created, model: turn.model, choices: [], usage: usageBody(res.usage) })
      }
      end()
    })
    .catch((error) => {
      clearTimeout(waiting)
      if (!started) return first.reject(error)
      raw({ error: { message: String(error?.message ?? error), type: "upstream_error", code: "upstream_error" } })
      end()
    })

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
  const send = (input, onEvent) =>
    chat({ session, cfg, input, signal: abort.signal, onEvent }).catch((e) => {
      const refusedDial = e instanceof UpstreamError && e.kind === "handshake" && e.status !== 401 && e.status !== 403
      if (session.wsHost === tenantHost || !refusedDial || abort.signal.aborted) throw e
      qbs.forgetCell(auth)
      session.wsHost = tenantHost
      return chat({ session, cfg, input, signal: abort.signal, onEvent })
    })
  const account = `${auth?.tenantUrl}|${auth?.accountId}`
  const keys = turn.convo.map(messageKey)
  const attempt = async (thread) => {
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
        settle()
        return res
      } catch (e) {
        threads.drop(thread)
        throw e
      }
    }
    return turn.stream ? stream(turn, run, abort, cfg.headerWaitMs) : complete(turn, run)
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
