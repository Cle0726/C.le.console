// An organization's tenant on the Gateway, against a local stand-in for one:
// sign-in without user-info, renewal, the account API and chat at the
// tenant's cell.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chatCompletions } from "../plugin/chat.mjs"
import * as oauth from "../plugin/oauth.mjs"
import * as qbs from "../plugin/qbs.mjs"
import { settings } from "../plugin/settings.mjs"
import { dialInfo, sessionFromAuth } from "../plugin/upstream.mjs"
import { gatewayDecode, gatewayEncode } from "../plugin/wire.mjs"

const WS_PATH = "/ws/service/SpaceNeedleConversationService/operation/ChatBidirectionalStream"
const ARN = "arn:aws:quicksight:us-east-1:123456789012:user/default/ada"
const jwt = (claims) => `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`

const state = {
  claims: null, // what the access token says; null for a token that is no JWT
  tokens: 0,
  asked: [], // every path asked over HTTP
  cellHost: "", // what /v1/discovery names
  dials: [], // the Host of every WebSocket opened
  frames: [], // every frame received
  accounts: [], // the account of every account API call
}
let server
let base

beforeAll(() => {
  const signedIn = (req) => /^Bearer \S+/.test(req.headers.get("authorization") ?? "")
  const refused = () => Response.json({ error: "invalid_request", error_description: "Missing Authorization header" }, { status: 401 })
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req, srv) {
      const url = new URL(req.url)
      state.asked.push(url.pathname)
      const account = /^\/accounts\/([^/]+)\/invocations\/rpc$/.exec(url.pathname)
      if (account) {
        if (!signedIn(req)) return refused()
        state.accounts.push(account[1])
        if (url.searchParams.get("innerPath") !== "profile/usage") return Response.json({ type: "api_response", status: 404, body: {} })
        return Response.json({ type: "api_response", status: 200, body: { session: { used: 1, limit: 100 }, subscription: { subscription_type: "ENTERPRISE" } } })
      }
      switch (url.pathname) {
        case "/.well-known/oauth-authorization-server":
          return Response.json({ scopes_supported: ["default", "offline_access"] })
        case "/oauth2/authorize": {
          const to = new URL(url.searchParams.get("redirect_uri"))
          to.searchParams.set("code", "code-1")
          to.searchParams.set("state", url.searchParams.get("state"))
          return Response.redirect(to.toString(), 302)
        }
        case "/oauth2/token": {
          const n = ++state.tokens
          return Response.json({ access_token: state.claims ? jwt({ ...state.claims, n }) : `access-${n}`, refresh_token: `refresh-${n}`, expires_in: 3600 })
        }
        // as the Gateway: no operation is bound to an App Integrations path
        case "/integration/quick-work/user-info":
          if (!signedIn(req)) return refused()
          return new Response("<UnknownOperationException/>", { status: 404, headers: { "content-type": "application/xml" } })
        case "/v1/discovery":
          if (!signedIn(req)) return refused()
          return state.cellHost ? Response.json({ cell: "cell-1", cellHost: state.cellHost }) : new Response("not found", { status: 404 })
        case WS_PATH:
          if (!signedIn(req)) return refused()
          state.dials.push(req.headers.get("host"))
          if (srv.upgrade(req)) return
          return new Response("WebSocket upgrade required", { status: 400 })
      }
      return new Response("<UnknownOperationException/>", { status: 404 })
    },
    websocket: {
      message(ws, data) {
        const event = JSON.parse(gatewayDecode(new Uint8Array(data))[0])
        state.frames.push(event)
        if (event.type !== "user_message") return
        for (const out of [
          { type: "text_delta", payload: { delta: "pong" } },
          { type: "turn_usage", payload: { input_tokens: 7, output_tokens: 1, total_tokens: 8 } },
          { type: "message_complete", payload: {} },
          { type: "turn_completed", payload: {} },
        ])
          ws.send(gatewayEncode(JSON.stringify(out)))
      },
    },
  })
  base = `http://127.0.0.1:${server.port}`
})

afterAll(() => server.stop(true))

// Signs in the way the plugin does, the account type picked being `provider`.
async function signIn(provider = "enterprise") {
  const flow = new oauth.LoginFlow({ provider, stage: "prod", region: "", port: 18080, appVersion: "1" })
  const discovered = new URLSearchParams({ nonce: flow.nonce, authEndpoint: base + "/oauth2/authorize", tokenEndpoint: base + "/oauth2/token", tenantUrl: base, clientId: "corp-client" })
  const granted = await fetch(await flow.processDiscovery(discovered), { redirect: "manual" })
  return flow.complete(new URL(granted.headers.get("location")).searchParams)
}

const ask = async (auth) => {
  const res = await chatCompletions({ body: { model: "fast", messages: [{ role: "user", content: "ping" }] }, auth, cfg: settings({ request_timeout: "10s" }) })
  return { status: res.status, body: await res.json() }
}

describe("which tenants are on the Gateway", () => {
  test("an organization's tenant is, by its host", () => {
    expect(oauth.providerFor("enterprise", "https://dc7qdw2e3.us-east-1.enterprise.quick.aws.com/")).toBe("gateway")
    expect(oauth.providerFor("enterprise", "t1.us-west-2.desktop.enterprise.quick.aws.com")).toBe("gateway")
    expect(oauth.providerFor("enterprise", "https://t1.us-east-1.enterprise.quick.aws.dev")).toBe("gateway")
    // an App Integrations tenant, and what is not a tenant at all, stay as picked
    expect(oauth.providerFor("enterprise", "https://us-east-1.dp.appintegrations.aws.dev")).toBe("enterprise")
    expect(oauth.providerFor("enterprise", "https://enterprise.quick.aws.com.example.org")).toBe("enterprise")
    expect(oauth.providerFor("enterprise", "")).toBe("enterprise")
    expect(oauth.providerFor("social", "https://t1.us-east-1.enterprise.quick.aws.com")).toBe("social")
    expect(oauth.providerFor("social_gateway", "https://x.example")).toBe("social_gateway")
  })

  test("who the account is comes from the tokens", () => {
    expect(oauth.claimedUserInfo({ accessToken: jwt({ sub: ARN, email: "ada@corp.example", name: "Ada" }) })).toEqual({
      email: "ada@corp.example",
      userName: "",
      displayName: "Ada",
      userArn: ARN,
      awsAccountId: "123456789012",
      accountName: "",
    })
    expect(oauth.claimedUserInfo({ accessToken: jwt({ sub: "u-1", preferred_username: "ada@corp.example", aws_account_id: "210987654321" }) })).toMatchObject({
      email: "ada@corp.example",
      userName: "ada@corp.example",
      userArn: "",
      awsAccountId: "210987654321",
    })
    expect(oauth.claimedUserInfo({ accessToken: "opaque", idToken: "" })).toEqual({ email: "", userName: "", displayName: "", userArn: "", awsAccountId: "", accountName: "" })
  })
})

describe("an organization's tenant on the Gateway", () => {
  test("a tenant without user-info signs in as a Gateway account, named by its tokens", async () => {
    state.claims = { sub: ARN, email: "ada@corp.example" }
    state.asked.length = 0
    const account = await signIn("enterprise")
    expect(state.asked).toContain("/integration/quick-work/user-info")
    expect(account).toMatchObject({
      quickProvider: "gateway",
      accountId: "ada@corp.example",
      email: "ada@corp.example",
      actorArn: ARN,
      awsAccountId: "123456789012",
      tenantUrl: base,
      wsHost: base.replace("http://", "ws://"),
      wsPath: WS_PATH,
      refresh: `refresh-${state.tokens}`,
    })

    // picked as a Gateway account, user-info is not asked at all
    state.asked.length = 0
    expect(await signIn("gateway")).toMatchObject({ quickProvider: "gateway", accountId: "ada@corp.example" })
    expect(state.asked).not.toContain("/integration/quick-work/user-info")

    // renewed, it stays what it is
    state.asked.length = 0
    expect(await oauth.refresh(account)).toMatchObject({ quickProvider: "gateway", accountId: "ada@corp.example", deviceId: account.deviceId, wsPath: WS_PATH })
    expect(state.asked).toEqual(["/oauth2/token"])
  })

  test("tokens that say nothing still sign in, the account named by its tenant", async () => {
    state.claims = null
    const account = await signIn("enterprise")
    expect(account).toMatchObject({ quickProvider: "gateway", accountId: "127.0.0.1", email: "", awsAccountId: "", access: `access-${state.tokens}` })
    expect(account.expires).toBeGreaterThan(Date.now() + 3000_000)
  })

  test("any other answer of user-info still fails the sign-in", async () => {
    const flow = new oauth.LoginFlow({ provider: "enterprise", stage: "prod", region: "", port: 18080, appVersion: "1" })
    const discovered = new URLSearchParams({ nonce: flow.nonce, authEndpoint: base + "/oauth2/authorize", tokenEndpoint: base + "/oauth2/token", tenantUrl: base, clientId: "corp-client" })
    const granted = await fetch(await flow.processDiscovery(discovered), { redirect: "manual" })
    // only the Gateway's own 404 says the tenant is one; a 401 is a sign-in that failed
    const real = globalThis.fetch
    globalThis.fetch = (url, init) => (String(url).endsWith("/user-info") ? Promise.resolve(new Response("unauthorized", { status: 401 })) : real(url, init))
    try {
      await expect(flow.complete(new URL(granted.headers.get("location")).searchParams)).rejects.toThrow("user info failed: HTTP 401")
    } finally {
      globalThis.fetch = real
    }
  })

  test("chat is dialed at the tenant's cell, and the account API at the tenant", async () => {
    state.claims = { sub: ARN, email: "ada@corp.example" }
    const account = await signIn("enterprise")
    qbs.forgetCell(account)
    state.cellHost = `ws://localhost:${server.port}`
    state.dials.length = state.frames.length = 0

    const { status, body } = await ask(account)
    expect(status).toBe(200)
    expect(body.choices[0].message.content).toBe("pong")
    expect(body.usage).toMatchObject({ prompt_tokens: 7, completion_tokens: 1 })
    expect(state.dials).toEqual([`localhost:${server.port}`])
    expect(state.frames.map((f) => f.type)).toEqual(["session_connect", "federate_status", "user_message"])
    expect(state.frames[2].payload).toMatchObject({ text: "ping", agent_mode: "fast" })

    state.accounts.length = 0
    expect(await qbs.usage(account)).toMatchObject({ plan: "Enterprise", user: "ada@corp.example" })
    expect(state.accounts).toEqual(["123456789012"])
  })

  test("the Gateway's chat is given the access token, the App Integrations side the id_token", () => {
    const bearer = (quickProvider) => dialInfo(sessionFromAuth({ quickProvider, access: "the-access", idToken: "the-id", wsHost: "h" }, {})).headers.Authorization
    expect(bearer("gateway")).toBe("Bearer the-access")
    expect(bearer("social_gateway")).toBe("Bearer the-access")
    expect(bearer("enterprise")).toBe("Bearer the-id")
    expect(bearer("social")).toBe("Bearer the-id")
    // with one of the two only, that one
    expect(dialInfo(sessionFromAuth({ quickProvider: "gateway", idToken: "the-id", wsHost: "h" }, {})).headers.Authorization).toBe("Bearer the-id")
    expect(dialInfo(sessionFromAuth({ quickProvider: "enterprise", access: "the-access", wsHost: "h" }, {})).headers.Authorization).toBe("Bearer the-access")
  })

  test("a tenant that names no cell, or a cell that does not answer, is dialed itself", async () => {
    const account = await signIn("enterprise")
    qbs.forgetCell(account)
    state.cellHost = ""
    state.dials.length = 0
    expect((await ask(account)).body.choices[0].message.content).toBe("pong")
    expect(state.dials).toEqual([`127.0.0.1:${server.port}`])

    qbs.forgetCell(account)
    state.cellHost = "ws://127.0.0.1:1"
    state.dials.length = 0
    expect((await ask(account)).body.choices[0].message.content).toBe("pong")
    expect(state.dials).toEqual([`127.0.0.1:${server.port}`])
    // the cell is asked for again the next time
    state.cellHost = `ws://localhost:${server.port}`
    state.dials.length = 0
    await ask(account)
    expect(state.dials).toEqual([`localhost:${server.port}`])
  })
})
