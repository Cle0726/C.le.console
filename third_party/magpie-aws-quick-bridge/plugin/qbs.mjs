// Amazon Quick's account API over HTTPS: the plan's usage, the account's
// settings and attachment uploads. Requests carry the account's access token.

import { createHash, randomUUID } from "node:crypto"
import { isGatewayProvider } from "./wire.mjs"

export class QbsError extends Error {
  constructor(message, status = 0) {
    super(message)
    this.status = status
  }
}

const base = (auth) => {
  const url = String(auth?.tenantUrl ?? "").replace(/\/+$/, "")
  if (!url) throw new QbsError("the account has no tenant_url; sign in again", 401)
  return url
}

const parsed = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

async function call(url, init, signal) {
  const res = await fetch(url, { ...init, signal: signal ?? AbortSignal.timeout(init.timeoutMs ?? 15_000) })
  const text = await res.text()
  if (!res.ok) throw new QbsError(`Amazon Quick answered ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`, res.status)
  return text
}

// The answer of an agent API path, which comes wrapped twice: the event
// envelope, then an api_response with its own status and body.
export function unwrap(text) {
  const outer = parsed(text)
  let inner = outer?.eventResponse?.invokeAgentResponse ?? outer?.invokeAgentResponse ?? outer
  if (typeof inner === "string") inner = parsed(inner) ?? inner
  if (!inner || typeof inner !== "object") return { status: 200, body: inner }
  const status = Number(inner.status ?? inner.statusCode) || 200
  let body = "body" in inner ? inner.body : inner
  if (typeof body === "string") body = parsed(body) ?? body
  return { status, body }
}

// The host a Gateway tenant's chat is dialed at: GET /v1/discovery names the
// tenant's cell. "" when the tenant does not say, and the tenant's own host
// is dialed. The answer is kept for an hour, a missing one for five minutes.
const cells = new Map()

export async function cellHost(auth, signal) {
  const tenant = base(auth)
  const known = cells.get(tenant)
  if (known && Date.now() < known.until) return known.host
  let host = ""
  const wait = AbortSignal.timeout(10_000)
  try {
    const headers = { authorization: `Bearer ${auth.access}`, "x-amzn-qs-internal-trace-id": randomUUID() }
    const body = parsed(await call(`${tenant}/v1/discovery`, { headers }, signal ? AbortSignal.any([signal, wait]) : wait))
    if (typeof body?.cellHost === "string") host = body.cellHost.trim()
  } catch {}
  if (signal?.aborted) return ""
  cells.set(tenant, { host, until: Date.now() + (host ? 60 : 5) * 60_000 })
  return host
}

// After a cell that did not answer: the tenant is asked again next time.
export const forgetCell = (auth) => cells.delete(base(auth))

// Calls one path of the agent backend (profile/usage, api/ws-rpc, …).
export async function invoke(auth, path, method = "GET", body = {}, { signal } = {}) {
  path = String(path).replace(/^\/+/, "")
  const headers = { "content-type": "application/json", authorization: `Bearer ${auth.access}`, "x-amzn-qs-internal-trace-id": randomUUID() }
  let text
  if (isGatewayProvider(auth.quickProvider)) {
    const query = new URLSearchParams({ innerPath: path, _method: method })
    const account = encodeURIComponent(auth.awsAccountId || "default")
    text = await call(`${base(auth)}/accounts/${account}/invocations/rpc?${query}`, { method: "POST", headers, body: JSON.stringify(body ?? {}) }, signal)
  } else {
    const event = { eventType: "invokeAgent", eventBody: { invokeAgent: { path, queryParams: { _method: method }, body: body ?? {} } } }
    text = await call(`${base(auth)}/integration/quick-work/qbs-event`, { method: "POST", headers, body: JSON.stringify(event) }, signal)
  }
  const res = unwrap(text)
  if (res.status >= 400) throw new QbsError(`Amazon Quick answered ${res.status} for ${path}`, res.status)
  return res.body
}

const PLANS = { QUICK_LITE_FREE_TRIAL: "Free Trial", FREE_TRIAL: "Free Trial", FREE: "Free", PRO: "Pro", TEAM: "Team", ENTERPRISE: "Enterprise" }

// A time as Amazon Quick gives it (epoch seconds or milliseconds, or ISO).
function isoTime(value) {
  let ms = NaN
  if (typeof value === "number" && value > 0) ms = value < 1e11 ? value * 1000 : value
  else if (typeof value === "string" && value.trim()) ms = /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value) * (Number(value) < 1e11 ? 1000 : 1) : Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : ""
}

function quotaWindow(name, q) {
  if (!q || typeof q !== "object") return null
  const limit = Number(q.limit) || 0
  const amount = Number(q.used) || 0
  const percent = Number(q.percent)
  if (limit <= 0 && !Number.isFinite(percent)) return null
  const out = { name }
  if (limit > 0) Object.assign(out, { amount, limit, unit: "credits", display: `${amount} / ${limit} credits` })
  else out.used = percent
  const resetsAt = isoTime(q.resets_at)
  if (resetsAt) out.resetsAt = resetsAt
  else if (Number(q.resume_in_minutes) > 0) out.resetSecs = Math.round(Number(q.resume_in_minutes) * 60)
  return out
}

// profile/usage as what magpie's auth.usage returns.
export function usageFromProfile(raw, auth) {
  const type = String(raw?.subscription?.subscription_type ?? "").trim()
  const out = { plan: PLANS[type.toUpperCase()] ?? (type || "Amazon Quick"), windows: [] }
  if (auth?.email) out.user = auth.email
  const until = isoTime(raw?.subscription?.free_trial_metadata?.expiry_date)
  if (until) out.until = until
  const monthly = quotaWindow("Monthly", raw?.monthly)
  if (monthly) out.windows.push(monthly)
  const session = quotaWindow("Session", raw?.session)
  if (session) out.windows.push(session)
  const overage = quotaWindow("Monthly overage", raw?.overage_monthly)
  if (overage && (overage.limit > 0 || overage.used > 0)) out.windows.push({ ...overage, aside: true })
  return out
}

export const usage = async (auth, opts) => usageFromProfile(await invoke(auth, "profile/usage", "GET", {}, opts), auth)

// The allowance of profile/usage that is used up, and the seconds until it
// is there again (0 when Amazon Quick doesn't say); null when none is. A
// month that is used up still runs while its overage has room.
export function spentAllowance(raw, now = Date.now()) {
  const spent = (q) => {
    if (!q || typeof q !== "object") return false
    const limit = Number(q.limit) || 0
    return limit > 0 ? Number(q.used) >= limit : Number(q.percent) >= 100
  }
  const secs = (q) => {
    const at = Date.parse(isoTime(q.resets_at))
    if (Number.isFinite(at)) return Math.max(0, Math.ceil((at - now) / 1000))
    return Number(q.resume_in_minutes) > 0 ? Math.round(Number(q.resume_in_minutes) * 60) : 0
  }
  const found = []
  if (spent(raw?.session)) found.push({ name: "session", secs: secs(raw.session) })
  const overage = raw?.overage_monthly
  if (spent(raw?.monthly) && !(Number(overage?.limit) > 0 && !spent(overage))) found.push({ name: "monthly", secs: secs(raw.monthly) })
  return found.sort((a, b) => b.secs - a.secs)[0] ?? null
}

// spentAllowance for the account, asked briefly: null when it can't be read.
export async function spent(auth) {
  try {
    return spentAllowance(await invoke(auth, "profile/usage", "GET", {}, { signal: AbortSignal.timeout(5_000) }))
  } catch {
    return null
  }
}

const SETTINGS_MS = 2 * 60_000
const settingsCache = new Map()

// The account's settings (model slots, advanced mode), kept for two minutes.
export async function settings(auth, opts) {
  const key = `${auth?.tenantUrl}|${auth?.accountId}`
  const hit = settingsCache.get(key)
  if (hit && Date.now() - hit.at < SETTINGS_MS) return hit.value
  const res = await invoke(auth, "api/ws-rpc", "POST", { type: "get_settings", payload: {} }, opts)
  const frames = Array.isArray(res?.frames) ? res.frames : []
  const value = frames.find((f) => f?.type === "settings")?.payload ?? res?.payload ?? null
  if (value && typeof value === "object") {
    if (settingsCache.size > 32) settingsCache.delete(settingsCache.keys().next().value)
    settingsCache.set(key, { at: Date.now(), value })
  }
  return value
}

const DLP_DONE = new Set(["COMPLETED", "SKIPPED", "NOT_APPLICABLE"])

// Uploads a file for the thread `threadId` and returns the attachment entry
// a user_message names it by. Amazon Quick scans an upload before it can be
// used, which is waited for here.
export async function upload(auth, { name, mimeType, bytes, threadId }, { signal } = {}) {
  if (isGatewayProvider(auth.quickProvider)) throw new QbsError("attachments are not supported on Gateway accounts")
  mimeType = String(mimeType || "application/octet-stream").split(";")[0].trim().toLowerCase()
  const data = bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(String(bytes))
  if (!data.byteLength) throw new QbsError("the attachment is empty")
  const bearer = { authorization: `Bearer ${auth.access}` }
  const query = new URLSearchParams({ name, contentType: mimeType, contentLength: String(data.byteLength) })
  const up = parsed(
    await call(`${base(auth)}/integration/quick-work/upload-attachment?${query}`, { method: "POST", headers: { ...bearer, "content-type": "application/octet-stream" }, body: data, timeoutMs: 60_000 }, signal),
  )
  const attachmentId = String(up?.attachmentId ?? "")
  if (!attachmentId) throw new QbsError("Amazon Quick returned no attachment id")

  for (let i = 0; i < 20; i++) {
    let dlp
    try {
      dlp = parsed(await call(`${base(auth)}/integration/quick-work/attachment-dlp-status?${new URLSearchParams({ attachmentId })}`, { headers: bearer }, signal))
    } catch (e) {
      if (e.status === 401 || e.status === 403) throw e
    }
    const status = String(dlp?.dlpJobStatus ?? dlp?.DlpJobStatus ?? "").toUpperCase()
    const action = String(dlp?.policyAction ?? dlp?.PolicyAction ?? "").toUpperCase()
    if (DLP_DONE.has(status)) {
      if (action && action !== "ALLOW" && action !== "WARN") throw new QbsError(`Amazon Quick's data protection policy blocked the attachment (${action})`, 400)
      break
    }
    if (status === "FAILED" || status === "ERROR") throw new QbsError(`Amazon Quick could not scan the attachment (${status})`)
    await new Promise((r) => setTimeout(r, 600))
  }

  const delivered = await invoke(auth, `files/upload/${encodeURIComponent(threadId)}`, "POST", { attachmentId }, { signal })
  return {
    type: mimeType.startsWith("image/") ? "image" : "file",
    name,
    size: data.byteLength,
    mimeType,
    path: String(delivered?.path ?? delivered?.files?.[0]?.path ?? "") || name,
    attachmentId,
    contentSha256: createHash("sha256").update(data).digest("hex"),
  }
}
