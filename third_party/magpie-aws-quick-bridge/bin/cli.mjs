#!/usr/bin/env node
// magpie-aws-quick-bridge on its own: Amazon Quick behind a local API
// address, for CC Switch and any agent that takes an address and a key.
// magpie users do not need this: magpie loads the plugin itself.

import { spawn } from "node:child_process"
import { readFileSync, realpathSync } from "node:fs"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { APPS, endpoint, importLink } from "../gateway/ccswitch.mjs"
import { createGateway, listen } from "../gateway/server.mjs"
import * as service from "../gateway/service.mjs"
import * as store from "../gateway/store.mjs"
import { browserSignIn } from "../plugin/login.mjs"
import * as oauth from "../plugin/oauth.mjs"
import * as qbs from "../plugin/qbs.mjs"
import { settings } from "../plugin/settings.mjs"

const NAME = "magpie-aws-quick-bridge"
const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version

const HELP = `${NAME} ${version}: Amazon Quick as a local API for CC Switch, Claude Code, Codex and OpenCode

  ${NAME} login            sign in to Amazon Quick in the browser
        --enterprise         an organization's account (IAM Identity Center / SSO)
        --region <region>    its AWS region (default us-east-1)
        --no-open            print the sign-in address instead of opening it
  ${NAME} serve            run the API on http://127.0.0.1:${store.DEFAULT_PORT}
        --port <n>  --host <h>
  ${NAME} ccswitch         print the links that add Amazon Quick to CC Switch
        --open               open them in CC Switch now
        --app <app>          only for ${Object.keys(APPS).join(", ")}
  ${NAME} status           the address, the key, the account and its quota
  ${NAME} key --new        replace the API key
  ${NAME} service install  macOS: keep the API running in the background
  ${NAME} service uninstall
  ${NAME} logout           forget the account

Settings and the account are kept in ${store.home()}
`

function parse(argv) {
  const flags = {}
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith("--")) rest.push(a)
    else if (a.includes("=")) flags[a.slice(2, a.indexOf("="))] = a.slice(a.indexOf("=") + 1)
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--") && !["open", "no-open", "enterprise", "new", "help", "version"].includes(a.slice(2))) flags[a.slice(2)] = argv[++i]
    else flags[a.slice(2)] = true
  }
  return { flags, rest }
}

const open = (target) => {
  const [cmd, args] = process.platform === "darwin" ? ["open", [target]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", target]] : ["xdg-open", [target]]
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true })
      .on("error", () => {})
      .unref()
  } catch {}
}

const base = (cfg) => `http://${cfg.host === "0.0.0.0" || cfg.host === "::" ? "127.0.0.1" : cfg.host}:${cfg.port}`

function setup() {
  const cfg = store.config()
  oauth.setEndpoints({ oidcBase: cfg.options.oidc_base, discoveryUrl: cfg.options.discovery_url, dataPlaneUrl: cfg.options.data_plane_url })
  return cfg
}

async function login(flags) {
  const cfg = setup()
  const options = settings(cfg.options)
  const provider = typeof flags.provider === "string" ? flags.provider : flags.enterprise ? "enterprise" : "social"
  const started = await browserSignIn({ provider, region: typeof flags.region === "string" ? flags.region : "" }, options)
  if (started.type === "failed") throw new Error(started.error)
  // the sign-in's own port and timers never keep the process alive
  const alive = setInterval(() => {}, 60_000)
  console.log(`Sign in to Amazon Quick in the browser:\n\n  ${started.url}\n`)
  if (!flags["no-open"]) open(started.url)

  // A browser on another computer ends on a localhost page that won't load
  // there: its address, pasted here, is opened on this computer instead.
  let rl
  if (process.stdin.isTTY) {
    console.log("Browser on another computer? Paste the address of each localhost page that won't load here, one a line.\n")
    rl = createInterface({ input: process.stdin })
    rl.on("line", async (line) => {
      let url
      try {
        url = new URL(line.trim())
      } catch {
        return
      }
      if (!["localhost", "127.0.0.1"].includes(url.hostname)) return
      url.hostname = "127.0.0.1"
      try {
        const res = await fetch(url, { redirect: "manual" })
        const next = res.headers.get("location")
        if (next) console.log(`\nNow open this page, and paste the address it ends on:\n\n  ${next}\n`)
      } catch (e) {
        console.log(`That address could not be opened: ${e.message}`)
      }
    })
  }
  const result = await started.callback()
  rl?.close()
  clearInterval(alive)
  if (result?.type !== "success") throw new Error(result?.error ?? "the sign-in failed")
  const { type: _type, ...fields } = result
  store.signedIn(fields)
  console.log(`Signed in as ${fields.accountId || "your account"}.\nNext: ${NAME} serve`)
}

async function serve(flags) {
  const cfg = setup()
  const port = flags.port ? Number(flags.port) : cfg.port
  const host = typeof flags.host === "string" ? flags.host : cfg.host
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port takes a number from 0 to 65535")
  const account = new store.Account()
  const log = (line) => console.log(`${new Date().toISOString()} ${line}`)
  let running
  try {
    running = await listen(createGateway({ apiKey: cfg.apiKey, account, options: cfg.options, log }), { port, host })
  } catch (e) {
    throw new Error(e?.code === "EADDRINUSE" ? `port ${port} is in use: the API may be running already (${NAME} status), or pick another with --port` : e.message)
  }
  const at = base({ host, port: running.port })
  console.log(`Amazon Quick API on ${at}\n  key:      ${cfg.apiKey}\n  account:  ${account.peek()?.accountId ?? `not signed in (${NAME} login)`}\n  Claude Code   ${endpoint("claude", at)}   (Anthropic Messages)\n  Codex         ${endpoint("codex", at)}   (OpenAI Responses)\n  OpenCode, …   ${endpoint("opencode", at)}   (OpenAI Chat Completions)\nAdd it to CC Switch: ${NAME} ccswitch --open\n`)
  const stop = () => {
    running.close()
    process.exit(0)
  }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
}

async function status() {
  const cfg = setup()
  const at = base(cfg)
  let up = false
  try {
    up = (await (await fetch(`${at}/health`, { signal: AbortSignal.timeout(2000) })).json())?.name === NAME
  } catch {}
  console.log(`API:      ${at}  (${up ? "running" : `not running; start it with ${NAME} serve`})`)
  console.log(`Key:      ${cfg.apiKey}`)
  if (process.platform === "darwin") console.log(`Service:  ${service.installed() ? "installed (starts at login)" : "not installed"}`)
  const account = new store.Account()
  let auth = account.peek()
  if (!auth) return console.log(`Account:  not signed in (${NAME} login)`)
  try {
    auth = await account.get()
    console.log(`Account:  ${auth.accountId}`)
  } catch (e) {
    return console.log(`Account:  ${auth.accountId}: ${e.message}`)
  }
  try {
    const usage = await qbs.usage(auth)
    console.log(`Plan:     ${usage.plan}`)
    for (const w of usage.windows) console.log(`  ${w.name}: ${w.display ?? `${w.used}% used`}`)
  } catch (e) {
    console.log(`Quota:    not available (${e.message})`)
  }
}

function ccswitch(flags) {
  const cfg = setup()
  const apps = typeof flags.app === "string" ? flags.app.split(",") : Object.keys(APPS)
  const at = typeof flags.url === "string" ? flags.url : base(cfg)
  for (const app of apps) {
    const link = importLink(app.trim(), { base: at, apiKey: cfg.apiKey, model: typeof flags.model === "string" ? flags.model : "smart" })
    console.log(`${APPS[app.trim()].label}:\n  ${link}\n`)
    if (flags.open) open(link)
  }
  console.log(flags.open ? "CC Switch asks you to confirm each one." : `Open a link in the browser, or run this again with --open, and confirm in CC Switch.`)
  console.log(`CC Switch only points the agent at ${at}: keep \`${NAME} serve\` running.`)
}

async function main() {
  const [command = "help", ...argv] = process.argv.slice(2)
  const { flags, rest } = parse(argv)
  if (command === "--version" || command === "-v" || command === "version") return console.log(version)
  if (command === "login") return login(flags)
  if (command === "serve") return serve(flags)
  if (command === "status") return status()
  if (command === "ccswitch" || command === "cc-switch") return ccswitch(flags)
  if (command === "key") return console.log(flags.new ? `${store.newKey()}\nRestart serve, and give the agents the new key.` : store.config().apiKey)
  if (command === "logout") {
    store.removeAccount()
    return console.log("The account is forgotten on this computer.")
  }
  if (command === "service") {
    if (rest[0] === "install") {
      service.install({ runtime: process.execPath, script: realpathSync(fileURLToPath(import.meta.url)) })
      return console.log(`The API now runs in the background and starts at login.\nLog: ${service.logPath()}`)
    }
    if (rest[0] === "uninstall") {
      service.uninstall()
      return console.log("The background service is removed.")
    }
    throw new Error("service takes install or uninstall")
  }
  console.log(HELP)
  if (!["help", "--help", "-h"].includes(command)) process.exitCode = 1
}

main().catch((e) => {
  console.error(`${NAME}: ${e?.message ?? e}`)
  process.exit(1)
})
