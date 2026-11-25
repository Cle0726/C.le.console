// SPDX-License-Identifier: GPL-3.0-only
// C.le.控制台 driver for the magpie-AWS-Quick-bridge sources (modified, see NOTICE.md) in
// third_party/magpie-aws-quick-bridge (© DaBinBinah, GPL-3.0). The console
// runs this as a separate process; it talks to it only through stdout JSON
// lines and the local HTTP API. Each account lives in its own folder
// (--home), so several accounts can run side by side.
//
//   cle-aws-quick login --home <dir> [--enterprise] [--region <r>]
//       prints {"event":"url","url":...} then {"event":"success",...} or {"event":"error",...}
//   cle-aws-quick serve --home <dir> --port <n>
//       prints {"event":"listening","port":n,"apiKey":...}; exits when stdin closes
//   cle-aws-quick status --home <dir>
//       prints {"event":"status","accountId":...,"plan":...,"windows":[...]}
//   cle-aws-quick import --home <dir>
//       reads one account as JSON on stdin (an account.json, an export with
//       other field names, or just {"access": "<token>"}), checks it with
//       Amazon Quick and saves it; prints {"event":"success",...} or {"event":"error",...}

import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import fs from "node:fs"
import { createServer, request as httpRequest } from "node:http"
import net from "node:net"
import path from "node:path"
import { createGateway, listen } from "../../third_party/magpie-aws-quick-bridge/gateway/server.mjs"
import * as store from "../../third_party/magpie-aws-quick-bridge/gateway/store.mjs"
import { browserSignIn } from "../../third_party/magpie-aws-quick-bridge/plugin/login.mjs"
import * as oauth from "../../third_party/magpie-aws-quick-bridge/plugin/oauth.mjs"
import * as qbs from "../../third_party/magpie-aws-quick-bridge/plugin/qbs.mjs"
import { settings } from "../../third_party/magpie-aws-quick-bridge/plugin/settings.mjs"

const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n")

// The subcommand is the first bare word, wherever it stands: C.le.控制台
// 1.1.57 sent `--home <dir> login`, later builds send `login --home <dir>`.
function parse(argv) {
  const flags = {}
  const words = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith("--")) {
      words.push(a)
      continue
    }
    const name = a.slice(2)
    if (["enterprise"].includes(name)) flags[name] = true
    else flags[name] = argv[++i] ?? ""
  }
  return { command: words[0] ?? "", flags }
}

function setup(flags) {
  if (!flags.home) throw new Error("--home is required")
  process.env.AWS_QUICK_BRIDGE_HOME = flags.home
  const cfg = store.config()
  oauth.setEndpoints({ oidcBase: cfg.options.oidc_base, discoveryUrl: cfg.options.discovery_url, dataPlaneUrl: cfg.options.data_plane_url })
  return cfg
}

async function login(flags) {
  const cfg = setup(flags)
  const options = settings(cfg.options)
  const provider = flags.enterprise ? "enterprise" : "social"
  const started = await browserSignIn({ provider, region: flags.region || "" }, options)
  if (started.type === "failed") throw new Error(started.error)
  const alive = setInterval(() => {}, 60_000)
  emit({ event: "url", url: started.url })
  const result = await started.callback()
  clearInterval(alive)
  if (result?.type !== "success") throw new Error(result?.error ?? "the sign-in failed")
  const { type: _type, ...fields } = result
  store.signedIn(fields)
  emit({ event: "success", accountId: fields.accountId || "", tenantUrl: fields.tenantUrl || "", provider })
  setTimeout(() => process.exit(0), 300)
}

// Amazon Quick answers a turn on a used-up allowance with ordinary text
// ("You've reached your usage limit…"), not an error, so the bridge would
// pass it on as the model's answer and the console's account pool would not
// move on to another account. Turns are checked against the allowance first
// (the answer kept briefly) and refused with 429 and Retry-After, the way
// the bridge answers a turn Quick refuses.
const TURNS = new Set(["/v1/chat/completions", "/chat/completions", "/v1/messages", "/messages", "/v1/responses", "/responses"])
const REST_MAX_SECS = 6 * 3600

function quotaGuard(handle, account, apiKey) {
  let known = { until: 0, spent: null }
  const keyOf = (headers) => headers.get("x-api-key") || (headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "")
  return async (request) => {
    const path = new URL(request.url).pathname.replace(/\/+$/, "")
    if (request.method !== "POST" || !TURNS.has(path) || keyOf(request.headers) !== apiKey) return handle(request)
    if (Date.now() >= known.until) {
      const auth = await account.get().catch(() => null)
      const spent = auth ? await qbs.spent(auth) : null
      known = { spent, until: Date.now() + (spent ? 60_000 : 20_000) }
    }
    const spent = known.spent
    if (!spent) return handle(request)
    const secs = Math.min(spent.secs > 0 ? spent.secs : REST_MAX_SECS, REST_MAX_SECS)
    const message = `Amazon Quick's ${spent.name} allowance is used up${spent.secs > 0 ? `; it is back in ${Math.max(1, Math.round(spent.secs / 60))} minutes` : ""}`
    const body = path.endsWith("/messages")
      ? { type: "error", error: { type: "rate_limit_error", message } }
      : { error: { message, type: "rate_limit_exceeded", code: "rate_limit_exceeded" } }
    return Response.json(body, { status: 429, headers: { "retry-after": String(secs) } })
  }
}

// Everything a gateway writes to stderr also goes to one log shared by all
// accounts, each line led by the port: <accounts>/../logs/bridge.log
// (~/.antigravity_cle/aws-quick/logs/bridge.log), moved to bridge.log.1 once
// it passes LOG_MAX. The console discards the sidecar's stderr.
const LOG_MAX = 20 * 1024 * 1024

function logToFile(home, port) {
  const dir = path.join(path.dirname(path.dirname(path.resolve(home))), "logs")
  const file = path.join(dir, "bridge.log")
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    return
  }
  const write = process.stderr.write.bind(process.stderr)
  let pending = ""
  process.stderr.write = (chunk, ...rest) => {
    try {
      pending += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
      const at = pending.lastIndexOf("\n")
      if (at >= 0) {
        const lines = pending.slice(0, at).split("\n").map((l) => `[${port}] ${l}\n`).join("")
        pending = pending.slice(at + 1)
        try {
          if (fs.statSync(file).size > LOG_MAX) fs.renameSync(file, file + ".1")
        } catch {}
        fs.appendFileSync(file, lines)
      }
    } catch {}
    try {
      return write(chunk, ...rest)
    } catch {
      return true
    }
  }
}

async function serve(flags) {
  const cfg = setup(flags)
  const port = flags.port ? Number(flags.port) : cfg.port
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port takes a number from 0 to 65535")
  // started by `lazy` on a private port, its log lines name the account's own
  logToFile(flags.home, flags["log-as"] || port)
  process.stderr.write(`${new Date().toISOString()} started ${flags.home}\n`)
  const account = new store.Account()
  const log = (line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`)
  const gateway = quotaGuard(createGateway({ apiKey: cfg.apiKey, account, options: cfg.options, log }), account, cfg.apiKey)
  const running = await listen(gateway, { port, host: "127.0.0.1" })
  emit({ event: "listening", port: running.port, apiKey: cfg.apiKey, accountId: account.peek()?.accountId ?? "" })
  const stop = () => {
    running.close()
    process.exit(0)
  }
  // The console keeps stdin open; it closes when the console exits or dies.
  process.stdin.on("end", stop)
  process.stdin.on("close", stop)
  process.stdin.resume()
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
}

// cle-aws-quick lazy --accounts <dir> [--idle-minutes 30]
// One process that stands in for every account whose port nobody serves:
// it listens on that port, answers /health itself, starts the account's
// gateway (serve, on a private port) on the first real request and passes
// requests through, and stops the gateway again after it has been idle.
// Accounts whose gateway already runs are left alone; the folder is looked
// at again every minute for new accounts and gateways that went away.
async function lazy(flags) {
  const accountsDir = path.resolve(flags.accounts || "")
  if (!flags.accounts || !fs.existsSync(accountsDir)) throw new Error("--accounts <dir> is required")
  const idleMs = Math.max(1, Number(flags["idle-minutes"]) || 30) * 60_000
  logToFile(path.join(accountsDir, "x"), "lazy")
  const log = (line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`)
  const managed = new Map() // port -> { home, server, child, inner, starting, last, busy }

  const freePort = () =>
    new Promise((resolve, reject) => {
      const s = net.createServer()
      s.once("error", reject)
      s.listen(0, "127.0.0.1", () => {
        const { port } = s.address()
        s.close(() => resolve(port))
      })
    })
  const healthy = (port) =>
    new Promise((resolve) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/health", timeout: 800 }, (res) => {
        res.resume()
        resolve(res.statusCode === 200)
      })
      req.on("error", () => resolve(false))
      req.on("timeout", () => (req.destroy(), resolve(false)))
      req.end()
    })
  // run from source, node runs this file again; packaged (pkg), starting the
  // program's own executable runs the script it is given first, which is
  // this one's own path inside the package, so it is the same call
  const self = [process.execPath, [process.argv[1]]]

  async function start(entry, port) {
    entry.starting ??= (async () => {
      const inner = await freePort()
      const child = spawn(self[0], [...self[1], "serve", "--home", entry.home, "--port", String(inner), "--log-as", String(port)], {
        // real pipes, drained: a gateway whose stdout is closed dies on its first line
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      })
      child.stdout.resume()
      child.stderr.resume()
      child.on("exit", () => {
        if (entry.child === child) entry.child = null
      })
      for (let i = 0; i < 100; i++) {
        if (child.exitCode !== null) break
        if (await healthy(inner)) {
          entry.child = child
          entry.inner = inner
          log(`port ${port}: started its gateway (${Math.round((Date.now() - entry.asked) / 100) / 10}s)`)
          return
        }
        await new Promise((r) => setTimeout(r, 100))
      }
      child.kill()
      throw new Error("the account's gateway did not start")
    })().finally(() => (entry.starting = null))
    return entry.starting
  }

  function serveFor(port, home) {
    const entry = { home, server: null, child: null, inner: 0, starting: null, last: Date.now(), busy: 0, asked: 0 }
    entry.server = createServer(async (req, res) => {
      if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
        res.writeHead(200, { "content-type": "application/json" })
        return res.end(JSON.stringify({ ok: true, name: "magpie-aws-quick-bridge" }))
      }
      entry.busy++
      entry.last = Date.now()
      try {
        if (!entry.child) {
          entry.asked = Date.now()
          await start(entry, port)
        }
        const up = httpRequest({ host: "127.0.0.1", port: entry.inner, method: req.method, path: req.url, headers: req.headers }, (answer) => {
          res.writeHead(answer.statusCode, answer.headers)
          answer.pipe(res)
        })
        up.on("error", (e) => {
          if (!res.headersSent) {
            res.writeHead(529, { "content-type": "application/json", "retry-after": "2" })
            res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: `local gateway: ${e.message}` } }))
          } else res.destroy()
        })
        res.on("close", () => {
          if (!res.writableFinished) up.destroy()
        })
        req.pipe(up)
        await new Promise((r) => res.on("close", r))
      } catch (e) {
        if (!res.headersSent) {
          res.writeHead(529, { "content-type": "application/json", "retry-after": "2" })
          res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: `local gateway: ${e?.message ?? e}` } }))
        }
      } finally {
        entry.busy--
        entry.last = Date.now()
      }
    })
    return new Promise((resolve) => {
      entry.server.once("error", () => resolve(false))
      entry.server.listen(port, "127.0.0.1", () => {
        managed.set(port, entry)
        resolve(true)
      })
    })
  }

  async function scan() {
    let dirs = []
    try {
      dirs = fs.readdirSync(accountsDir, { withFileTypes: true }).filter((d) => d.isDirectory())
    } catch {}
    for (const d of dirs) {
      const home = path.join(accountsDir, d.name)
      let port = 0
      try {
        if (!JSON.parse(fs.readFileSync(path.join(home, "account.json"), "utf8")).access) continue
        port = Number(JSON.parse(fs.readFileSync(path.join(home, "cle.json"), "utf8")).port)
      } catch {
        continue
      }
      if (!port || managed.has(port)) continue
      if (await healthy(port)) continue // its own gateway runs: left alone
      if (await serveFor(port, home)) log(`port ${port}: waiting for requests`)
    }
  }

  const reap = () => {
    for (const [port, entry] of managed)
      if (entry.child && !entry.busy && Date.now() - entry.last > idleMs) {
        entry.child.kill()
        entry.child = null
        log(`port ${port}: stopped its gateway after ${Math.round(idleMs / 60_000)} idle minutes`)
      }
  }

  // Every account's token, whether or not its gateway runs, renewed on a
  // timer: a gateway renews only when a request comes, so an idle account's
  // token would otherwise be renewed by nobody. Renewing does not change the
  // refresh token (measured), so a gateway renewing the same account at the
  // same time does no harm. Done here, in this process, one account at a time.
  const statusFile = path.join(path.dirname(accountsDir), "logs", "renewal-status.json")
  const renewal = {}
  try {
    Object.assign(renewal, JSON.parse(fs.readFileSync(statusFile, "utf8")))
  } catch {}
  const writeStatus = () => {
    try {
      fs.writeFileSync(statusFile, JSON.stringify(renewal, null, 2))
    } catch {}
  }
  const RENEW_BEFORE_MS = 30 * 60_000 // half of the 60-minute token
  const RETRY_MS = 60_000
  let renewing = false
  async function renewAll() {
    if (renewing) return
    renewing = true
    try {
      for (const d of fs.readdirSync(accountsDir, { withFileTypes: true })) {
        if (!d.isDirectory()) continue
        const home = path.join(accountsDir, d.name)
        let auth, port
        try {
          auth = JSON.parse(fs.readFileSync(path.join(home, "account.json"), "utf8"))
          port = String(JSON.parse(fs.readFileSync(path.join(home, "cle.json"), "utf8")).port)
        } catch {
          continue
        }
        if (!auth?.access || !auth.refresh || auth.refresh === "none") continue
        const state = (renewal[port] ??= {})
        if (auth.expires && auth.expires - Date.now() >= RENEW_BEFORE_MS) continue
        // a failed renewal is tried again a minute later, after three in a row every five
        const wait = (state.failures || 0) >= 3 ? 5 * RETRY_MS : RETRY_MS
        if (state.failedAt && Date.now() - Date.parse(state.failedAt) < wait) continue
        process.env.AWS_QUICK_BRIDGE_HOME = home
        try {
          let options = {}
          try {
            options = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")).options ?? {}
          } catch {}
          oauth.setEndpoints({ oidcBase: options.oidc_base, discoveryUrl: options.discovery_url, dataPlaneUrl: options.data_plane_url })
          const next = await new store.Account().renew()
          state.renewedAt = new Date().toISOString()
          state.expires = next?.expires ? new Date(next.expires).toISOString() : ""
          state.failedAt = ""
          state.lastError = ""
          state.failures = 0
          log(`port ${port}: token renewed, good until ${state.expires.slice(11, 19)}Z`)
        } catch (e) {
          state.failedAt = new Date().toISOString()
          state.lastError = String(e?.message ?? e).slice(0, 300)
          state.failures = (state.failures || 0) + 1
          log(`port ${port}: RENEWAL FAILED (${state.failures}): ${state.lastError}`)
        }
        writeStatus()
      }
    } finally {
      renewing = false
    }
  }

  await scan()
  emit({ event: "lazy", ports: [...managed.keys()].sort((a, b) => a - b) })
  setInterval(() => void scan().catch(() => {}), 60_000)
  setInterval(reap, 60_000)
  void renewAll().catch(() => {})
  setInterval(() => void renewAll().catch(() => {}), 60_000)
  const stop = () => {
    for (const entry of managed.values()) entry.child?.kill()
    process.exit(0)
  }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
}

async function status(flags) {
  setup(flags)
  const account = new store.Account()
  let auth = account.peek()
  if (!auth) return emit({ event: "status", signedIn: false })
  try {
    auth = await account.get()
  } catch (e) {
    return emit({ event: "status", signedIn: true, accountId: auth.accountId, expired: e?.signIn === "expired", error: String(e?.message ?? e) })
  }
  try {
    // a dropped connection (seen as "fetch failed" on some networks) is asked again; an answer is not
    let usage
    for (let attempt = 1; ; attempt++) {
      try {
        usage = await qbs.usage(auth)
        break
      } catch (e) {
        if (e instanceof qbs.QbsError || attempt >= 3) throw e
        await new Promise((resolve) => setTimeout(resolve, 800 * attempt))
      }
    }
    emit({ event: "status", signedIn: true, accountId: auth.accountId, plan: usage.plan, windows: usage.windows })
  } catch (e) {
    emit({ event: "status", signedIn: true, accountId: auth.accountId, error: String(e?.message ?? e) })
  }
}

// Names other exports use for the fields an account.json keeps.
const ALIASES = {
  access: ["access", "accessToken", "access_token"],
  refresh: ["refresh", "refreshToken", "refresh_token"],
  idToken: ["idToken", "id_token"],
  expires: ["expires", "expiresAt", "expires_at", "expiration"],
  tenantUrl: ["tenantUrl", "tenant_url"],
  quickProvider: ["quickProvider", "quick_provider", "provider"],
  clientId: ["clientId", "client_id"],
  clientSecret: ["clientSecret", "client_secret"],
  region: ["region"],
  idcRegion: ["idcRegion", "idc_region"],
  stage: ["stage"],
  tokenEndpoint: ["tokenEndpoint", "token_endpoint"],
  issuerUrl: ["issuerUrl", "issuer_url"],
  redirectUri: ["redirectUri", "redirect_uri"],
  deviceId: ["deviceId", "device_id"],
  accountId: ["accountId", "account_id"],
  email: ["email"],
  displayName: ["displayName", "display_name"],
  accountName: ["accountName", "account_name"],
  awsAccountId: ["awsAccountId", "aws_account_id"],
  actorArn: ["actorArn", "actor_arn"],
}

function normalize(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("导入内容必须是一个 JSON 对象")
  // an export that wraps the account: { account: {...} } and the like
  const has = (o) => o && typeof o === "object" && ["access", "accessToken", "access_token", "refresh", "refreshToken", "refresh_token"].some((k) => o[k])
  if (!has(raw)) {
    const inner = ["account", "auth", "credentials", "tokens", "token"].map((k) => raw[k]).find(has)
    if (inner) raw = { ...raw, ...inner }
  }
  const out = {}
  for (const [name, keys] of Object.entries(ALIASES)) {
    const value = keys.map((k) => raw[k]).find((v) => v !== undefined && v !== null && String(v).trim() !== "")
    if (value !== undefined) out[name] = typeof value === "string" ? value.trim() : value
  }
  if (out.expires !== undefined) {
    const n = Number(out.expires)
    out.expires = Number.isFinite(n) && n > 0 ? (n < 1e12 ? n * 1000 : n) : Date.parse(String(out.expires)) || 0
  }
  out.quickProvider = oauth.normalizedProvider(out.quickProvider)
  out.stage = oauth.normalizedStage(out.stage)
  return out
}

const readStdin = async () => {
  let text = ""
  process.stdin.setEncoding("utf8")
  for await (const chunk of process.stdin) text += chunk
  return text
}

// The account's details from its own tenant; empty when it won't say.
async function userInfo(tenantUrl, access) {
  try {
    const res = await fetch(`${String(tenantUrl).replace(/\/+$/, "")}/integration/quick-work/user-info`, {
      method: "POST",
      headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return {}
    const info = oauth.normalizeUserInfo(await res.json())
    return Object.fromEntries(Object.entries(info).filter(([, v]) => v))
  } catch {
    return {}
  }
}

const refused = (e) => e instanceof qbs.QbsError && (e.status === 401 || e.status === 403)

async function importAccount(flags) {
  setup(flags)
  let raw
  try {
    raw = JSON.parse(await readStdin())
  } catch {
    throw new Error("导入内容不是有效的 JSON")
  }
  const base = normalize(raw)
  if (!base.access && !base.refresh) throw new Error("没有找到 access token（access / accessToken / access_token）")
  const renewable = Boolean(base.refresh && base.refresh !== "none" && (base.clientId || base.tokenEndpoint))
  if (!base.access && !renewable) throw new Error("只有 refresh token 时还需要 clientId 和 clientSecret 才能换出 access token")

  let fields = null
  if (base.access) {
    const tokens = { accessToken: base.access, refreshToken: base.refresh ?? "", idToken: base.idToken ?? "", expiresIn: 0 }
    let info = oauth.claimedUserInfo(tokens)
    const named = (i) => i.email || i.userName || i.displayName || i.userArn
    // Amazon Quick's tokens are opaque: ask who the account is, the way a
    // sign-in does, without renewing (which would retire the pasted refresh token)
    if (!named(info) && !base.email && base.tenantUrl && !["gateway", "social_gateway"].includes(base.quickProvider))
      info = { ...info, ...(await userInfo(base.tenantUrl, base.access)) }
    // a token that names nobody still needs a name of its own, or every such
    // import would land on the same account
    if (!named(info) && !base.accountId && !base.email)
      base.accountId = "token-" + createHash("sha256").update(base.access).digest("hex").slice(0, 8)
    fields = oauth.sessionFields(base, tokens, info)
    if (base.expires) fields.expires = base.expires
  }

  let renewed = false
  const renew = async () => {
    fields = await oauth.refresh(fields ?? base)
    renewed = true
  }
  if (!fields || (fields.expires && fields.expires < Date.now() + 60_000)) {
    if (!renewable) throw new Error("这个 token 已过期，而且没有可用的 refresh token / clientId，无法续期")
    await renew()
  }

  let warning = ""
  try {
    await qbs.usage(fields)
  } catch (e) {
    if (!refused(e)) warning = `没能向 Amazon Quick 确认这个账号：${e?.message ?? e}`
    else if (renewable && !renewed) {
      await renew()
      await qbs.usage(fields)
    } else if (!base.tenantUrl)
      // a token only works on its account's own cell (qbs-cell….dp.appintegrations…), which it does not name
      throw new Error("Amazon Quick 拒绝了这个 token：缺少账号的 tenantUrl（形如 https://qbs-cell….dp.appintegrations.us-east-1.prod.plato.ai.aws.dev），请一并填写")
    else throw new Error("Amazon Quick 拒绝了这个 token（无效或已过期）")
  }

  store.signedIn(fields)
  emit({ event: "success", accountId: fields.accountId || "", tenantUrl: fields.tenantUrl || "", provider: fields.quickProvider, renewable, expires: fields.expires || 0, warning })
  setTimeout(() => process.exit(0), 300)
}

async function main() {
  const { command, flags } = parse(process.argv.slice(2))
  if (command === "login") return login(flags)
  if (command === "serve") return serve(flags)
  if (command === "status") return status(flags)
  if (command === "lazy") return lazy(flags)
  if (command === "import") return importAccount(flags)
  if (command === "version") return emit({ event: "version", version: "magpie-aws-quick-bridge 0.3.11 (5a8d414)" })
  throw new Error("usage: cle-aws-quick login|serve|status|import --home <dir>")
}

main().catch((e) => {
  emit({ event: "error", message: String(e?.message ?? e) })
  process.exit(1)
})
