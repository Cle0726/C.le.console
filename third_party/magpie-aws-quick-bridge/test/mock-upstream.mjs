// A local stand-in for Amazon Quick: the discovery page, the IAM Identity
// Center OIDC endpoints, user-info, the account API (usage, settings,
// attachments) and the chat WebSocket (AIDP framing).
// Used by the tests, and on its own to try the plugin in a magpie sandbox:
//   bun test/mock-upstream.mjs 39100

import { createHash } from "node:crypto"
import { eventStreamEncode } from "../plugin/wire.mjs"

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url")
const jwt = (claims) => `${b64url({ alg: "none" })}.${b64url(claims)}.sig`

export function startMock({ port = 0, email = "ada@example.com" } = {}) {
  const state = {
    codes: new Map(), // code -> code_challenge
    refreshes: 0,
    turns: [], // every user_message payload received
    dials: [], // the outpostId in the address of every WebSocket opened
    connects: [], // every session_connect payload received
    custom: new Map(), // thread_id -> the custom_prompt it was last given
    uploads: [], // { name, contentType, size, text, thread }
    settings: { advanced_mode_enabled: false, model_slots: {} },
    rejectToken: "", // an id_token the WebSocket upgrade answers 401
    script: null, // (payload) => events[], overrides the default reply
    limit: 65_250, // the bytes of a user_message's JSON over which it is refused
    refused: [], // the size of every message refused for it
    delayMs: 0, // how long a reply is held back, as a model that thinks
    idleMs: 0, // as Amazon Quick's 95 s: a client silent this long is dropped with IDLE_TIMEOUT (0: never)
    pings: 0, // the ping messages received
    stops: [], // the thread of every stop_generation received
    usage: null, // what profile/usage answers instead of an account with plenty left
  }

  const frame = (event) =>
    eventStreamEncode(
      { ":event-type": "rawOutputEvent", ":content-type": "application/json", ":message-type": "event" },
      JSON.stringify({ payload: Buffer.from(JSON.stringify(event)).toString("base64") }),
    )

  function heard(ws) {
    clearTimeout(ws.data.idle)
    if (!(state.idleMs > 0)) return
    ws.data.idle = setTimeout(() => {
      ws.send(frame({ type: "error", code: "IDLE_TIMEOUT", message: `Client sent no frames for >${state.idleMs} ms` }))
      ws.close(1000, "Streaming completed successfully.")
    }, state.idleMs)
  }

  function reply(payload) {
    if (state.script) return state.script(payload)
    const usage = { type: "turn_usage", payload: { input_tokens: 12, output_tokens: 5, total_tokens: 20, cache_read_tokens: 3 } }
    const done = [usage, { type: "message_complete", payload: {} }, { type: "turn_completed", payload: {} }]
    const tool = /use the tool (\w+)/i.exec(payload.text)
    if (tool && String(state.custom.get(payload.thread_id) ?? "").includes("<client_tool_protocol>")) {
      const marker = `<client_tool_call>{"name":"${tool[1]}","arguments":{"city":"Paris"}}</client_tool_call>`
      // split inside the marker, as a real stream may
      return [
        { type: "text_delta", payload: { delta: "Let me check. <client_to" } },
        { type: "text_delta", payload: { delta: marker.slice("<client_to".length, 40) } },
        { type: "text_delta", payload: { delta: marker.slice(40) } },
        ...done,
      ]
    }
    const words = `pong from ${payload.agent_mode}`.split(" ")
    return [...words.map((w, i) => ({ type: "text_delta", payload: { delta: (i ? " " : "") + w } })), ...done]
  }

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req, srv) {
      const url = new URL(req.url)
      const base = `http://127.0.0.1:${srv.port}`
      const json = async () => {
        try {
          return await req.json()
        } catch {
          return {}
        }
      }
      switch (url.pathname) {
        // the sign-in page: straight back to the plugin's port
        case "/sn": {
          const [, nonce, callbackPort] = (url.searchParams.get("qwSurface") ?? "").split(":")
          const to = new URL(`http://localhost:${callbackPort}/callback`)
          to.searchParams.set("nonce", nonce)
          to.searchParams.set("issuerUrl", "https://view.awsapps.com/start")
          to.searchParams.set("tenantUrl", base)
          to.searchParams.set("idcRegion", "us-east-1")
          return Response.redirect(to.toString(), 302)
        }
        case "/client/register":
          return Response.json({ clientId: "mock-client", clientSecret: "mock-secret" })
        case "/authorize": {
          const code = "code-" + Math.random().toString(36).slice(2)
          state.codes.set(code, url.searchParams.get("code_challenge"))
          const to = new URL(url.searchParams.get("redirect_uri"))
          to.searchParams.set("code", code)
          to.searchParams.set("state", url.searchParams.get("state"))
          return Response.redirect(to.toString(), 302)
        }
        case "/token": {
          const body = await json()
          const tokens = (n) => ({
            accessToken: `access-${n}`,
            refreshToken: `refresh-${n}`,
            idToken: jwt({ sub: "arn:aws:quicksight:us-east-1:123456789012:user/default/ada", n }),
            expiresIn: 3600,
          })
          if (body.grantType === "authorization_code") {
            const challenge = state.codes.get(body.code)
            const given = createHash("sha256").update(String(body.codeVerifier)).digest("base64url")
            if (!challenge || challenge !== given) return Response.json({ error: "invalid_grant" }, { status: 400 })
            state.codes.delete(body.code)
            return Response.json(tokens(0))
          }
          if (body.grantType === "refresh_token") {
            if (!String(body.refreshToken).startsWith("refresh-")) return Response.json({ error: "invalid_grant" }, { status: 400 })
            return Response.json(tokens(++state.refreshes))
          }
          return Response.json({ error: "unsupported_grant_type" }, { status: 400 })
        }
        case "/integration/quick-work/user-info":
          if (!/^Bearer access-/.test(req.headers.get("authorization") ?? "")) return new Response("unauthorized", { status: 401 })
          return Response.json({ userInfo: { email, displayName: "Ada", awsAccountId: "123456789012", accountName: "mock" } })
        case "/integration/quick-work/qbs-event": {
          if (!/^Bearer access-/.test(req.headers.get("authorization") ?? "")) return new Response("unauthorized", { status: 401 })
          const { path, body } = (await json()).eventBody?.invokeAgent ?? {}
          const answer = (value) =>
            Response.json({ eventType: "invokeAgent", eventResponse: { invokeAgentResponse: JSON.stringify({ type: "api_response", status: 200, body: value, body_encoding: "json" }) } })
          if (path === "profile/usage")
            return answer(state.usage ?? {
              session: { used: 3, limit: 100, label: "Session usage", percent: 3, resume_in_minutes: 0 },
              monthly: { used: 17, limit: 600, label: "Monthly usage", percent: 2, resets_at: 1796083200 },
              subscription: { subscription_type: "QUICK_LITE_FREE_TRIAL", free_trial_metadata: { status: "ACTIVE", expiry_date: 1797688435 } },
            })
          if (path === "api/ws-rpc" && body?.type === "get_settings") return answer({ frames: [{ type: "autonomous_mode_status", payload: {} }, { type: "settings", payload: state.settings }] })
          if (path?.startsWith("files/upload/")) {
            const upload = state.uploads.find((u) => u.id === body?.attachmentId)
            if (!upload) return answer({ error: "no such attachment" })
            upload.thread = decodeURIComponent(path.slice("files/upload/".length))
            return answer({ path: `/data/workspace/attached_files/${upload.name}` })
          }
          return Response.json({ eventResponse: { invokeAgentResponse: JSON.stringify({ type: "api_response", status: 404, body: {} }) } })
        }
        case "/integration/quick-work/upload-attachment": {
          const bytes = new Uint8Array(await req.arrayBuffer())
          const id = `att-${state.uploads.length + 1}`
          state.uploads.push({ id, name: url.searchParams.get("name"), contentType: url.searchParams.get("contentType"), size: bytes.byteLength, text: new TextDecoder().decode(bytes) })
          return Response.json({ attachmentId: id })
        }
        case "/integration/quick-work/attachment-dlp-status":
          return Response.json({ dlpJobStatus: "COMPLETED", policyAction: "ALLOW" })
        case "/streaming/quickwork-chat-bidirectional-stream": {
          const token = url.searchParams.get("token") ?? ""
          if (!token || token === state.rejectToken) return new Response("unauthorized", { status: 401 })
          state.dials.push(url.searchParams.get("outpostId") ?? "")
          if (srv.upgrade(req, { data: {} })) return
          return new Response("expected a WebSocket", { status: 400 })
        }
      }
      return new Response("not found", { status: 404 })
    },
    websocket: {
      open(ws) {
        heard(ws)
      },
      close(ws) {
        ws.data.closed = true
        clearTimeout(ws.data.idle)
      },
      message(ws, data) {
        // only a message counts as the client being there; a WebSocket ping never gets here
        heard(ws)
        let event
        let bytes
        try {
          const outer = JSON.parse(typeof data === "string" ? data : Buffer.from(data).toString("utf8"))
          const inner = Buffer.from(outer.payload.payload, "base64")
          bytes = inner.byteLength
          event = JSON.parse(inner.toString("utf8"))
        } catch {
          return
        }
        if (event.type === "ping") state.pings++
        if (event.type === "session_connect") state.connects.push(event.payload)
        // as Amazon Quick: a turn told to stop ends with what it had written
        if (event.type === "stop_generation") {
          state.stops.push(event.payload?.thread_id)
          ws.data.stopped = true
          ws.send(frame({ type: "text_complete", payload: { text: "" } }))
          return ws.send(frame({ type: "message_complete", payload: {} }))
        }
        if (event.type !== "user_message") return
        // as Amazon Quick: a message whose JSON is over some 65250 bytes is
        // refused (state.limit, for a test to lower)
        if (bytes > state.limit) {
          state.refused.push(bytes)
          return ws.send(frame({ type: "error", code: "FrameTooLarge", message: "This message is over the 64 KB size limit, so it was not sent.", source: "sncs", retryable: false }))
        }
        state.turns.push(event.payload)
        if (event.payload.custom_prompt) state.custom.set(event.payload.thread_id, event.payload.custom_prompt)
        const events = reply(event.payload)
        // { wait: ms } in a script holds back what follows it
        const answer = async () => {
          for (const out of events) {
            if (out.wait) await new Promise((r) => setTimeout(r, out.wait))
            if (ws.data.closed || ws.data.stopped) return
            if (!out.wait) ws.send(frame(out))
          }
        }
        if (state.delayMs > 0) setTimeout(answer, state.delayMs)
        else answer()
      },
    },
  })

  return { server, state, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

if (import.meta.main) {
  const mock = startMock({ port: Number(process.argv[2]) || 39100 })
  console.log(`mock Amazon Quick on ${mock.url}`)
  console.log(`plugin options: ${JSON.stringify({ oidc_base: mock.url, discovery_url: mock.url + "/sn", data_plane_url: mock.url })}`)
}
