// The standalone gateway: Amazon Quick behind a local HTTP address, for
// CC Switch and any agent that takes an API address and a key. It answers
// the three APIs agents speak, each on top of the plugin's chat completions:
//   POST /v1/chat/completions   OpenAI Chat Completions (OpenCode, …)
//   POST /v1/messages           Anthropic Messages      (Claude Code)
//   POST /v1/responses          OpenAI Responses        (Codex)
//   GET  /v1/models
// magpie does not use this: it loads the plugin (index.mjs) itself.

import { timingSafeEqual } from "node:crypto"
import { createServer } from "node:http"
import { MODES, chatCompletions, mapModel } from "../plugin/chat.mjs"
import * as oauth from "../plugin/oauth.mjs"
import * as qbs from "../plugin/qbs.mjs"
import { MODEL_NAMES, accountModels, models, settings } from "../plugin/settings.mjs"
import { conversationOf } from "../plugin/threads.mjs"
import * as anthropic from "./anthropic.mjs"
import * as responses from "./responses.mjs"

const MAX_BODY = 64 * 1024 * 1024
const SIGN_IN = "Amazon Quick is not signed in; run: npx magpie-aws-quick-bridge login"

const openai = (status, message, code = "invalid_request_error") => Response.json({ error: { message, type: code, code } }, { status })

// The Quick mode a client's model name stands for. Agents ask for their own
// models when nobody tells them otherwise: a small one (Claude Code's
// background model) is answered by "fast", anything else by the default.
export function quickModel(model, fallback) {
  const mode = mapModel(model, "")
  if (mode) return mode
  return /haiku|mini|nano|small|flash/i.test(String(model ?? "")) ? "fast" : fallback
}

function sameKey(given, key) {
  const a = Buffer.from(String(given ?? ""))
  const b = Buffer.from(key)
  return a.length === b.length && timingSafeEqual(a, b)
}

const givenKey = (headers) => headers.get("x-api-key") || (headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "")

// /v1/messages, /messages and /v1/v1/messages are one route: clients differ
// on whether the address they are given ends in /v1.
const route = (pathname) => pathname.replace(/\/+$/, "").replace(/^(\/v1)+(?=\/|$)/, "") || "/"

// handle(Request) -> Response. `account` is a store.Account (or anything
// with get()); `options` are the plugin's options.
export function createGateway({ apiKey, account, options = {}, log = () => {} }) {
  const cfg = settings(options)
  oauth.setEndpoints({ oidcBase: options.oidc_base, discoveryUrl: options.discovery_url, dataPlaneUrl: options.data_plane_url })

  // The account for a request, or the answer that says why there is none.
  async function signedIn(fail) {
    try {
      const auth = await account.get()
      return auth ? { auth } : { response: fail(401, SIGN_IN) }
    } catch (e) {
      return { response: fail(e?.signIn === "expired" ? 401 : 502, `${e?.message ?? e}${e?.signIn === "expired" ? "; run: npx magpie-aws-quick-bridge login" : ""}`) }
    }
  }

  async function modelList() {
    let listed = models()
    try {
      const auth = await account.get()
      if (auth) listed = accountModels(listed, await qbs.settings(auth))
    } catch {}
    const created = Math.floor(Date.now() / 1000)
    const data = Object.keys(listed).map((id) => ({
      id,
      object: "model",
      created,
      owned_by: "amazon-quick",
      // what Anthropic's list carries
      type: "model",
      display_name: MODEL_NAMES[id] ?? id,
      created_at: new Date(created * 1000).toISOString(),
    }))
    return Response.json({ object: "list", data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null })
  }

  async function turn(request, api, fail) {
    let body
    try {
      body = await request.json()
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error()
    } catch {
      return fail(400, "the request body is not a JSON object")
    }
    if (api === "tokens") return anthropic.countTokens(body)
    if (api === "responses" && body.previous_response_id) return fail(400, "previous_response_id is not supported: responses are not stored; send the conversation in input")

    const { auth, response } = await signedIn(fail)
    if (response) return response
    const req =
      api === "messages"
        ? anthropic.toChat(body)
        : api === "responses"
          ? responses.toChat(body, request.headers)
          : { chat: body }
    // what the API itself names the conversation by comes first
    req.conversation ||= conversationOf(request.headers)
    req.chat.model = quickModel(req.chat.model, cfg.defaultModel)
    log(`${api} ${req.chat.model}${req.chat.stream ? " stream" : ""}`)
    const ask = (auth) => chatCompletions({ body: req.chat, auth, cfg, signal: request.signal, conversation: String(req.conversation).slice(0, 256) })
    let answer = await ask(auth)
    // Amazon Quick refused the token before its time: renew it and ask once more
    if (answer.status === 401 && answer.headers.get("x-magpie-sign-in") === "expired" && account.renew) {
      try {
        const renewed = await account.renew()
        if (renewed) answer = await ask(renewed)
      } catch (e) {
        if (e?.signIn !== "expired") throw e
        return fail(401, `${e.message}; run: npx magpie-aws-quick-bridge login`)
      }
    }
    // why a turn failed, for whoever reads the log later
    if (!answer.ok) {
      const said = await answer.clone().text().catch(() => "")
      log(`${api} -> ${answer.status} ${said.replace(/\s+/g, " ").slice(0, 300)}`)
    }
    if (api === "messages") return anthropic.fromChat(answer, req)
    if (api === "responses") return responses.fromChat(answer, req)
    return answer
  }

  return async function handle(request) {
    const url = new URL(request.url)
    const path = route(url.pathname)
    const fail = path.startsWith("/messages") ? anthropic.error : path === "/responses" ? responses.error : openai
    if (request.method === "GET" && (path === "/" || path === "/health")) return Response.json({ ok: true, name: "magpie-aws-quick-bridge" })
    if (!sameKey(givenKey(request.headers), apiKey)) return fail(401, "the API key is wrong; `npx magpie-aws-quick-bridge status` prints the right one", "invalid_api_key")
    try {
      if (request.method === "GET" && path === "/models") return await modelList()
      if (request.method === "POST" && path === "/chat/completions") return await turn(request, "chat", fail)
      if (request.method === "POST" && path === "/messages") return await turn(request, "messages", fail)
      if (request.method === "POST" && path === "/messages/count_tokens") return await turn(request, "tokens", fail)
      if (request.method === "POST" && path === "/responses") return await turn(request, "responses", fail)
    } catch (e) {
      if (request.signal.aborted) return new Response(null, { status: 499 })
      log(`error: ${e?.message ?? e}`)
      return fail(502, String(e?.message ?? e), "upstream_error")
    }
    return fail(404, `no such route: ${request.method} ${url.pathname}`, "not_found")
  }
}

// Serves `handle` on node:http (Node and Bun both have it). Resolves once it
// listens, with { port, close }.
export function listen(handle, { port, host }) {
  const server = createServer(async (req, res) => {
    const abort = new AbortController()
    res.on("close", () => {
      if (!res.writableFinished) abort.abort()
    })
    try {
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > MAX_BODY) {
          res.writeHead(413, { "content-type": "application/json" })
          return res.end(JSON.stringify({ error: { message: "the request is too large", type: "invalid_request_error" } }))
        }
        chunks.push(chunk)
      }
      const headers = new Headers()
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v)
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks)
      const answer = await handle(new Request(`http://${req.headers.host || "localhost"}${req.url}`, { method: req.method, headers, body, signal: abort.signal }))
      res.writeHead(answer.status, Object.fromEntries(answer.headers))
      if (!answer.body) return res.end()
      // Read and written one chunk at a time: Readable.fromWeb(...).pipe(res)
      // delivers chunks out of order on Bun 1.3.11.
      const reader = answer.body.getReader()
      res.on("close", () => reader.cancel().catch(() => {}))
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return res.end()
        if (!res.write(value)) await new Promise((next) => res.once("drain", next).once("close", next))
        if (res.destroyed) return
      }
    } catch (e) {
      if (res.headersSent) return res.destroy()
      res.writeHead(500, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: String(e?.message ?? e), type: "server_error" } }))
    }
  })
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, host, () =>
      resolve({
        port: server.address().port,
        close: () => {
          server.close()
          server.closeAllConnections?.()
        },
        // stops taking connections and closes the idle ones; a request still
        // being answered is answered first
        drain: () => {
          server.close()
          server.closeIdleConnections?.()
        },
      }),
    )
  })
}

export { MODES }
