// The browser sign-in: Amazon Quick's page comes back to a port here twice,
// first with the discovery result (answered with a redirect to the
// authorize page), then with the OAuth code.
//
// The browser may be on another computer (magpie on a server or in Docker).
// magpie then takes the address each tab ended on and opens it here itself,
// which it offers only for a sign-in whose address names a localhost
// redirect_uri. Amazon Quick's address has none, so the sign-in starts at
// /start on this port, which names it and sends the browser on.

import { createServer } from "node:http"
import { LoginFlow, StepError, isEnterpriseDiscovery, normalizedProvider } from "./oauth.mjs"

const escapeHTML = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

function page(ok, title, detail) {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHTML(title)}</title>` +
    `<style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem;color:${ok ? "#1a1a1a" : "#8a1c1c"}}</style></head>` +
    `<body><h2>${escapeHTML(title)}</h2><p>${escapeHTML(detail)}</p></body></html>`
  )
}

async function listen(ports) {
  for (const port of ports) {
    const server = createServer()
    const ok = await new Promise((resolve) => {
      server.once("error", () => resolve(false))
      server.listen(port, "127.0.0.1", () => resolve(true))
    })
    if (ok) {
      // the sign-in never keeps the plugin host alive by itself
      server.unref()
      return { server, port: server.address().port }
    }
  }
  return null
}

// Ends the sign-in under way, if any, and frees its port: one left behind (a
// closed tab) would otherwise hold the port until it timed out.
let signingIn = null

// Starts a sign-in and returns what an oauth method's authorize returns.
export async function browserSignIn(inputs, cfg, { signal } = {}) {
  const provider = normalizedProvider(inputs?.provider ?? cfg.provider)
  const region = String(inputs?.region ?? "").trim() || cfg.region
  signingIn?.()

  // An enterprise client is registered by the organization with one
  // redirect address, so only the configured port will do there; a social
  // client is registered here, for whichever port is free.
  const first = cfg.callbackPort
  const ports = isEnterpriseDiscovery(provider) || !first ? [first] : [first, first + 1, first + 2, first + 3, 0]
  const listening = await listen(ports)
  if (!listening)
    return { type: "failed", error: `port ${first} is busy; close what uses it or set the callback_port option, then sign in again` }
  const { server, port } = listening
  const flow = new LoginFlow({ provider, stage: cfg.stage, region, port, appVersion: cfg.appVersion })

  let over = false
  let busy = false
  let settle
  const done = new Promise((r) => (settle = r))
  const finish = (result) => {
    if (over) return
    over = true
    settle(result)
  }

  server.on("request", async (req, res) => {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { "cache-control": "no-store", "content-type": "text/html; charset=utf-8", ...headers })
      res.end(body)
    }
    let url
    try {
      url = new URL(req.url, `http://127.0.0.1:${port}`)
    } catch {
      return send(404, page(false, "Not found", "This address is not part of the sign-in."))
    }
    const q = url.searchParams
    if (over) return send(410, page(false, "Sign-in is over", "Start the sign-in again from magpie."))
    try {
      if (url.pathname === "/start") return send(302, "", { location: flow.loginUrl })
      if (url.pathname === "/callback" && q.get("nonce")) {
        const next = await flow.processDiscovery(q)
        // a pasted address is opened by magpie, not a browser: its user is
        // told where to go on (magpie prints this in the terminal)
        if (!/^Mozilla\//.test(req.headers["user-agent"] ?? "")) console.error(`Amazon Quick sign-in, next page to open: ${next}`)
        return send(302, "", { location: next })
      }
      if ((url.pathname === "/" || url.pathname === "/index.html") && (q.get("code") || q.get("error")) && q.get("state")) {
        if (busy) return send(409, page(false, "Sign-in is finishing", "This address is already being used to finish the sign-in."))
        busy = true
        const fields = await flow.complete(q)
        send(200, page(true, "Login complete", `${fields.accountId || "Your account"} is signed in. You can close this tab.`))
        return finish({ ...fields, type: "success", refresh: fields.refresh || "none" })
      }
    } catch (e) {
      busy = false
      const status = e instanceof StepError ? e.status : 500
      send(status, page(false, "Sign-in failed", e.message))
      // a wrong or stale address (400) leaves the sign-in waiting for the right one
      if (status !== 400 || q.get("error")) finish({ type: "failed", error: e.message })
      return
    }
    send(404, page(false, "Not found", "This address is not part of the sign-in."))
  })

  const timer = setTimeout(() => finish({ type: "failed", error: "the sign-in timed out" }), cfg.loginTimeoutMs)
  timer.unref?.()
  const end = () => {
    if (signingIn === superseded) signingIn = null
    server.close()
    server.closeAllConnections?.()
  }
  const superseded = () => {
    finish({ type: "failed", error: "another sign-in to Amazon Quick was started" })
    end()
  }
  signingIn = superseded
  const cancelled = () => superseded()
  signal?.addEventListener("abort", cancelled, { once: true })
  done.then(() => {
    clearTimeout(timer)
    signal?.removeEventListener("abort", cancelled)
    // a reloaded tab is still told the sign-in is over for a moment
    setTimeout(end, 5_000).unref?.()
  })

  return {
    url: `http://127.0.0.1:${port}/start?redirect_uri=${encodeURIComponent(`http://localhost:${port}/callback`)}`,
    instructions:
      "Sign in to Amazon Quick in the browser. If magpie runs on another computer, open this in your own browser instead:\n" +
      flow.loginUrl +
      "\nIt ends on a localhost page that won't load: paste that page's complete address into magpie, open the page magpie names next, and paste the address that one ends on too.",
    method: "auto",
    callback: (_code, ctx) => {
      ctx?.signal?.addEventListener("abort", cancelled, { once: true })
      return done
    },
  }
}
