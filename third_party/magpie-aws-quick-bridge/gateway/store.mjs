// Where the standalone gateway keeps its settings and the signed-in account:
// ~/.aws-quick-bridge (AWS_QUICK_BRIDGE_HOME names another folder). magpie
// keeps accounts itself and never reads this.

import { randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import * as oauth from "../plugin/oauth.mjs"

export const DEFAULT_PORT = 18765
export const DEFAULT_HOST = "127.0.0.1"
const REFRESH_LEAD_MS = 10 * 60_000
const UNKNOWN_LIFETIME_MS = 50 * 60_000

export const home = () => process.env.AWS_QUICK_BRIDGE_HOME || join(homedir(), ".aws-quick-bridge")
// `dir` names an account folder other than home(): one process can serve
// several accounts (cle-aws-quick multi), each with its own folder.
const file = (name, dir = home()) => join(dir, name)

function read(name, dir) {
  try {
    const value = JSON.parse(readFileSync(file(name, dir), "utf8"))
    return value && typeof value === "object" ? value : null
  } catch {
    return null
  }
}

// Written beside the file and moved over it, readable by the owner only:
// the account file holds tokens.
function write(name, value, dir = home()) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = file(`${name}.${process.pid}.tmp`, dir)
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
  try {
    chmodSync(tmp, 0o600)
  } catch {}
  renameSync(tmp, file(name, dir))
}

// config.json: { apiKey, port, host, options }. `options` are the plugin's
// options (README), the same names magpie's plugins.json takes. The key is
// made on first use.
export function config(dir) {
  const saved = read("config.json", dir) ?? {}
  const out = {
    apiKey: typeof saved.apiKey === "string" && saved.apiKey.trim() ? saved.apiKey.trim() : "",
    port: Number.isInteger(saved.port) && saved.port > 0 && saved.port < 65536 ? saved.port : DEFAULT_PORT,
    host: typeof saved.host === "string" && saved.host.trim() ? saved.host.trim() : DEFAULT_HOST,
    options: saved.options && typeof saved.options === "object" ? saved.options : {},
  }
  if (!out.apiKey) {
    out.apiKey = "sk-quick-" + randomBytes(24).toString("hex")
    write("config.json", { ...saved, ...out }, dir)
  }
  return out
}

export function saveConfig(patch) {
  const next = { ...(read("config.json") ?? {}), ...patch }
  write("config.json", next)
  return next
}

export const newKey = () => saveConfig({ apiKey: "sk-quick-" + randomBytes(24).toString("hex") }).apiKey

export const saveAccount = (auth, dir) => write("account.json", auth, dir)

// Saves the account a sign-in ended with. The same account signing in again
// keeps the device id it had.
export function signedIn(fields) {
  const was = read("account.json")
  const same = was?.deviceId && was.accountId === fields.accountId && was.tenantUrl === fields.tenantUrl
  saveAccount({ ...fields, ...(same ? { deviceId: was.deviceId } : {}), type: "oauth" })
}
export const removeAccount = () => rmSync(file("account.json"), { force: true })
export const accountFile = () => file("account.json")

// The signed-in account, read again when the file changes (a sign-in while
// the gateway runs is picked up) and renewed shortly before it expires.
export class Account {
  #dir
  #auth = null
  #stamp = ""
  #renewing = null

  constructor(dir) {
    this.#dir = dir
  }

  peek() {
    let stamp = ""
    try {
      const s = statSync(file("account.json", this.#dir))
      stamp = `${s.mtimeMs}:${s.size}`
    } catch {}
    if (stamp !== this.#stamp) {
      this.#stamp = stamp
      const value = stamp ? read("account.json", this.#dir) : null
      this.#auth = value?.type === "oauth" && value.access ? value : null
    }
    return this.#auth
  }

  // The account with a token that is good for a while yet; null when nobody
  // is signed in. A refused renewal is thrown with signIn: "expired".
  async get() {
    const auth = this.peek()
    if (!auth) return auth
    // an imported token whose expiry nobody knows is renewed on first use:
    // the renewal says when the new one expires, and it is renewed in time
    // from then on (left as it was, it is used until Amazon Quick refuses it)
    if (!auth.expires && auth.refresh && auth.refresh !== "none") {
      try {
        return await this.renew()
      } catch (e) {
        if (e?.signIn === "expired") throw e
        return auth
      }
    }
    if (!auth.expires || auth.expires - Date.now() > REFRESH_LEAD_MS) return auth
    try {
      return await this.renew()
    } catch (e) {
      if (e?.signIn === "expired" || auth.expires <= Date.now()) throw e
      // a renewal that failed for another reason: the token still has time
      return auth
    }
  }

  // Renews the token now, whatever time it has left: Amazon Quick can refuse
  // a token before it expires. Requests that arrive together share one renewal.
  renew() {
    const auth = this.peek()
    if (!auth) return Promise.resolve(null)
    this.#renewing ??= (async () => {
      const next = { ...auth, ...(await oauth.refresh(auth)) }
      // a renewal that names no expiry is taken to last as Amazon Quick's
      // tokens do (an hour), less a margin, so it is renewed again in time
      if (!next.expires) next.expires = Date.now() + UNKNOWN_LIFETIME_MS
      saveAccount(next, this.#dir)
      return next
    })().finally(() => (this.#renewing = null))
    return this.#renewing
  }
}

export const exists = (name) => existsSync(file(name))
