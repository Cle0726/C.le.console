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

import { createGateway, listen } from "../../third_party/magpie-aws-quick-bridge/gateway/server.mjs"
import * as store from "../../third_party/magpie-aws-quick-bridge/gateway/store.mjs"
import { browserSignIn } from "../../third_party/magpie-aws-quick-bridge/plugin/login.mjs"
import * as oauth from "../../third_party/magpie-aws-quick-bridge/plugin/oauth.mjs"
import * as qbs from "../../third_party/magpie-aws-quick-bridge/plugin/qbs.mjs"
import { settings } from "../../third_party/magpie-aws-quick-bridge/plugin/settings.mjs"

const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n")

function parse(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith("--")) continue
    const name = a.slice(2)
    if (["enterprise"].includes(name)) flags[name] = true
    else flags[name] = argv[++i] ?? ""
  }
  return flags
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
    const usage = await qbs.usage(auth)
    emit({ event: "status", signedIn: true, accountId: auth.accountId, plan: usage.plan, windows: usage.windows })
  } catch (e) {
    emit({ event: "status", signedIn: true, accountId: auth.accountId, error: String(e?.message ?? e) })
  }
}

async function main() {
  const [command = "", ...argv] = process.argv.slice(2)
  const flags = parse(argv)
  if (command === "login") return login(flags)
  if (command === "serve") return serve(flags)
  if (command === "status") return status(flags)
  if (command === "version") return emit({ event: "version", version: "magpie-aws-quick-bridge 0.3.11 (5a8d414)" })
  throw new Error("usage: cle-aws-quick login|serve|status --home <dir>")
}

main().catch((e) => {
  emit({ event: "error", message: String(e?.message ?? e) })
  process.exit(1)
})
