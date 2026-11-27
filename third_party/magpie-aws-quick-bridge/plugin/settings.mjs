// The plugin's options and the models it lists, shared by the magpie plugin
// (index.mjs) and the standalone gateway (gateway/).

import { MODES, mapModel } from "./chat.mjs"
import * as oauth from "./oauth.mjs"

export const MODEL_NAMES = { smart: "Quick Smart", fast: "Quick Fast", balanced: "Quick Balanced", auto: "Quick Auto", advanced: "Quick Advanced" }

// "30s", "5m", "1h" or a number of seconds.
export function durationMs(value, fallback) {
  if (typeof value === "number" && value > 0) return value * 1000
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/.exec(String(value ?? ""))
  if (!m || !(Number(m[1]) > 0)) return fallback
  return Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] ?? "s"]
}

const text = (value, fallback = "") => (typeof value === "string" && value.trim() ? value.trim() : fallback)

// The plugin's options (plugins.json).
export function settings(options = {}) {
  // 0 takes any free port
  const port = typeof options.callback_port === "number" ? options.callback_port : Number(options.callback_port || NaN)
  const effort = text(options.thinking_effort).toLowerCase()
  return {
    appVersion: text(options.app_version, "1.2.4660"),
    surface: text(options.surface, "QUICK_WORK_DESKTOP_WINDOWS"),
    outpostId: text(options.outpost_id),
    // without an outpost_id the account's own device id is sent; false sends none
    stableDeviceId: options.stable_device_id !== false,
    workingSessionId: text(options.working_session_id),
    timezone: text(options.timezone, "UTC"),
    locale: text(options.locale, "en-US"),
    thinkingEffort: ["off", "low", "medium", "high"].includes(effort) ? effort : "",
    keepSessions: options.keep_sessions === true,
    webSearch: options.web_search === true,
    // false: every request starts a new thread and sends the whole conversation
    stateful: options.stateful !== false,
    attachments: options.attachments !== false,
    // what a message may weigh; Amazon Quick refuses one somewhat under 64 KB (see frameBytes). 0 sends any size
    maxFrameBytes: Number.isInteger(options.max_frame_bytes) && options.max_frame_bytes >= 0 ? options.max_frame_bytes : 63_000,
    defaultModel: mapModel(options.default_model, "smart"),
    // a whole turn; a long think is allowed for, silence is cut off sooner (READ_IDLE_MS)
    requestTimeoutMs: durationMs(options.request_timeout, 30 * 60_000),
    // how often a ping message is sent while a reply is awaited; Amazon Quick drops a client silent for 95 seconds
    keepaliveMs: Math.min(durationMs(options.keepalive_interval, 25_000), 60_000),
    // a streamed request is answered once Amazon Quick writes or this long has passed, whichever is first; "off" waits for it to write
    headerWaitMs: /^(off|0)$/i.test(String(options.header_wait ?? "").trim()) ? 0 : durationMs(options.header_wait, 10_000),
    // the tools Amazon Quick runs itself are named with the thinking, as "[Quick: web_search]"
    showQuickTools: options.show_quick_tools !== false,
    proxy: text(options.proxy),
    provider: oauth.normalizedProvider(options.provider),
    stage: oauth.normalizedStage(options.build_stage),
    region: text(options.region),
    callbackPort: Number.isInteger(port) && port >= 0 && port < 65536 ? port : 18080,
    loginTimeoutMs: durationMs(options.login_timeout, 30 * 60_000),
  }
}

// The window a client may fill. Amazon Quick's models have 1M tokens, but a
// request takes about 63000 bytes (one frame) and the rest of a conversation
// lives in Quick's thread on one account: when it has to be sent again (a new
// thread, another account) it goes as that frame plus an attachment, and a
// client that counted on 1M (it was 900K) kept far more than can be sent
// again before it compacted. The output limits are estimates, Quick publishes
// none.
export const CONTEXT_TOKENS = 128_000
export const model = (id) => ({
  name: MODEL_NAMES[id] ?? `Quick ${id}`,
  limit: { context: CONTEXT_TOKENS, output: id === "fast" ? 32_000 : 64_000 },
  tool_call: true,
  reasoning: true,
  attachment: true,
  variants: { low: {}, medium: {}, high: {} },
  modalities: { input: ["text", "image"], output: ["text"] },
})

export const models = () => Object.fromEntries(MODES.map((id) => [id, model(id)]))

// The account's own list: its settings name the modes it may not use and
// say whether it has the advanced one.
export function accountModels(listed, account) {
  const out = { ...listed }
  const slots = account?.model_slots
  const entries = Array.isArray(slots) ? slots.map((s) => [s?.id, s]) : Object.entries(slots && typeof slots === "object" ? slots : {})
  let advanced = account?.advanced_mode_enabled === true
  for (const [id, slot] of entries) {
    if (typeof id !== "string" || !slot || typeof slot !== "object") continue
    if (slot.enabled === false) delete out[id]
    else if (id === "advanced") advanced = true
  }
  if (advanced && !out.advanced) out.advanced = { ...(listed.smart ?? {}), ...model("advanced"), id: "advanced" }
  return out
}
