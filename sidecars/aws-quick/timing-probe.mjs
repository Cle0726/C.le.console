// Where a turn's time goes, run in-process with the bridge's own code:
//   node sidecars/aws-quick/timing-probe.mjs <account folder> [smart|fast] [runs]
// Wraps fetch and WebSocket to stamp every HTTP call (allowance, settings,
// uploads), the socket's dial and open, each frame sent and the first of
// each kind received. Prints times and frame types only, never tokens.
import { createGateway } from "../../third_party/magpie-aws-quick-bridge/gateway/server.mjs"
import * as store from "../../third_party/magpie-aws-quick-bridge/gateway/store.mjs"
import { aidpDecode } from "../../third_party/magpie-aws-quick-bridge/plugin/wire.mjs"
import * as qbs from "../../third_party/magpie-aws-quick-bridge/plugin/qbs.mjs"

const [home, model = "smart", runs = "3"] = process.argv.slice(2)
let t0 = 0
const marks = []
const mark = (what) => marks.push([Date.now() - t0, what])

const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const u = new URL(typeof input === "string" ? input : input.url)
  const name = `${init?.method ?? "GET"} ${u.host.split(".")[0]}${u.pathname}`
  const s = Date.now()
  try {
    const r = await realFetch(input, init)
    mark(`http ${name} -> ${r.status} (${Date.now() - s} ms)`)
    return r
  } catch (e) {
    mark(`http ${name} failed (${Date.now() - s} ms)`)
    throw e
  }
}
const RealWS = globalThis.WebSocket
globalThis.WebSocket = class extends RealWS {
  constructor(url, opts) {
    mark(`ws dial ${new URL(url).host.split(".")[0]}`)
    super(url, opts)
    const seen = new Set()
    this.addEventListener("open", () => mark("ws open"))
    this.addEventListener("close", (e) => mark(`ws close ${e.code}`))
    this.addEventListener("message", (e) => {
      let types = []
      try {
        types = (typeof e.data === "string" ? [e.data] : aidpDecode(e.data)).map((f) => JSON.parse(f).type)
      } catch {}
      for (const t of types) if (!seen.has(t) || seen.has("message_complete")) (seen.add(t), mark(`ws ${seen.has("message_complete") && t !== "message_complete" ? "after-complete" : "first"} ${t}`))
    })
  }
  send(data) {
    try {
      const [f] = typeof data === "string" ? [data] : aidpDecode(data)
      mark(`ws send ${JSON.parse(f).type}`)
    } catch {
      mark("ws send ?")
    }
    return super.send(data)
  }
}

const cfg = store.config(home)
const account = new store.Account(home)
const handle = createGateway({ apiKey: cfg.apiKey, account, options: cfg.options })
for (let i = 0; i < Number(runs); i++) {
  marks.length = 0
  t0 = Date.now()
  const auth = await account.get()
  mark("token ready")
  await qbs.spent(auth) // what the sidecar's allowance check does (cached there 20-60 s)
  mark("allowance checked")
  const res = await handle(new Request("http://x/v1/messages", { method: "POST", headers: { "x-api-key": cfg.apiKey, "content-type": "application/json" }, body: JSON.stringify(process.env.PROBE_TOOLS ? { model, max_tokens: 200, stream: true, tools: [{ name: "Read", description: "Read a file", input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } }], messages: [{ role: "user", content: "Use the Read tool to read C:\work\a.txt" }] } : { model, max_tokens: 20, stream: true, messages: [{ role: "user", content: "reply: ok" }] }) }))
  mark(`response headers ${res.status}`)
  const reader = res.body.getReader()
  let first = true
  for (;;) {
    const { done } = await reader.read()
    if (done) break
    if (first) (mark("first body bytes"), (first = false))
  }
  mark("body done")
  console.log(`--- run ${i + 1} (${model})`)
  for (const [ms, what] of marks) console.log(String(ms).padStart(6) + " ms  " + what)
}
process.exit(0)
