// Keeps the gateway running in the background on macOS (a launchd agent):
// started at login, restarted if it stops. Other systems run `serve`
// themselves.

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir, userInfo } from "node:os"
import { dirname, join } from "node:path"
import { home } from "./store.mjs"

export const LABEL = "com.dabinbinah.aws-quick-bridge"
export const plistPath = () => join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`)
export const logPath = () => join(home(), "serve.log")

const xml = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c])

export function plist({ runtime, script, env = {} }) {
  const vars = Object.entries(env)
    .map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>\n`)
    .join("")
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(runtime)}</string>
    <string>${xml(script)}</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${vars}  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(logPath())}</string>
  <key>StandardErrorPath</key><string>${xml(logPath())}</string>
</dict>
</plist>
`
}

const launchctl = (...args) => spawnSync("launchctl", args, { encoding: "utf8" })
const domain = () => `gui/${userInfo().uid}`

export function install({ runtime, script }) {
  if (process.platform !== "darwin") throw new Error("the background service is for macOS only; on this system keep `magpie-aws-quick-bridge serve` running yourself")
  // npx keeps a package only for a while: a service started from there stops working
  if (/[\\/]_npx[\\/]/.test(script)) throw new Error("install the package first, so the service has a file that stays: npm install -g magpie-aws-quick-bridge, then aws-quick-bridge service install")
  mkdirSync(dirname(plistPath()), { recursive: true })
  mkdirSync(home(), { recursive: true, mode: 0o700 })
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" }
  if (process.env.AWS_QUICK_BRIDGE_HOME) env.AWS_QUICK_BRIDGE_HOME = process.env.AWS_QUICK_BRIDGE_HOME
  launchctl("bootout", domain(), plistPath())
  writeFileSync(plistPath(), plist({ runtime, script, env }))
  const res = launchctl("bootstrap", domain(), plistPath())
  if (res.status !== 0) throw new Error(`launchctl could not start the service: ${(res.stderr || res.stdout).trim()}`)
}

export function uninstall() {
  if (process.platform !== "darwin") throw new Error("the background service is for macOS only")
  launchctl("bootout", domain(), plistPath())
  rmSync(plistPath(), { force: true })
}

export const installed = () => process.platform === "darwin" && existsSync(plistPath())
