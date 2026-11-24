// SPDX-License-Identifier: GPL-3.0-only
// C.le.控制台 driver for the unmodified magpie-AWS-Quick-bridge sources in
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

async function serve(flags) {
  const cfg = setup(flags)
  const port = flags.port ? Number(flags.port) : cfg.port
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port takes a number from 0 to 65535")
  const account = new store.Account()
  const log = (line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`)
  const running = await listen(createGateway({ apiKey: cfg.apiKey, account, options: cfg.options, log }), { port, host: "127.0.0.1" })
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
  if (command === "import") return importAccount(flags)
  if (command === "version") return emit({ event: "version", version: "magpie-aws-quick-bridge 0.3.11 (5a8d414)" })
  throw new Error("usage: cle-aws-quick login|serve|status|import --home <dir>")
}

main().catch((e) => {
  emit({ event: "error", message: String(e?.message ?? e) })
  process.exit(1)
})
