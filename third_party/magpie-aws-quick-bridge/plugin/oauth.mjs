// Native Amazon Quick desktop sign-in and token refresh, ported from
// aws-quickwork-2api's internal/oauth. Nothing here needs the official
// desktop app.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"

export const GATEWAY_WS_PATH = "/ws/service/SpaceNeedleConversationService/operation/ChatBidirectionalStream"
const ENTERPRISE_SCOPE = "openid profile email"

const SOCIAL_DISCOVERY = {
  prod: "https://quick.aws.com/sn",
  beta: "https://devtest.quicksuite.aws.dev/sn",
  integ: "https://devtest.quicksuite.aws.dev/sn",
  dev: "https://devtest.quicksuite.aws.dev/sn",
}

const SOCIAL_DATA_PLANE = {
  prod: "https://cell001.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev",
  beta: "https://cell001.dp.appintegrations.us-west-2.beta.plato.ai.aws.dev",
  integ: "https://cell001.dp.appintegrations.us-west-2.beta.plato.ai.aws.dev",
  dev: "https://cell001.dp.appintegrations.us-west-2.beta.plato.ai.aws.dev",
}

const SOCIAL_SCOPES = {
  prod: ["quicksight:read_write"],
  beta: ["quicksight_test:read_write"],
  integ: ["quicksight_test:read_write"],
  dev: ["quicksight_test:read_write"],
}

const ENTERPRISE_DISCOVERY = {
  prod: "https://quicksight.aws.amazon.com/sn/start/app-integrations/quickwork-enterprise-login",
  beta: "https://spaceneedle-alpha.amazon.com/sn/start/app-integrations/quickwork-enterprise-login",
  integ: "https://spaceneedle-beta.amazon.com/sn/start/app-integrations/quickwork-enterprise-login",
  dev: "https://spaceneedle-alpha.amazon.com/sn/start/app-integrations/quickwork-enterprise-login",
}

// Endpoint overrides (plugin options oidc_base, discovery_url,
// data_plane_url), for a private stage or a mock upstream in tests.
const endpoints = { oidcBase: "", discoveryUrl: "", dataPlaneUrl: "" }

export function setEndpoints(next = {}) {
  endpoints.oidcBase = String(next.oidcBase ?? "").replace(/\/+$/, "")
  endpoints.discoveryUrl = String(next.discoveryUrl ?? "")
  endpoints.dataPlaneUrl = String(next.dataPlaneUrl ?? "").replace(/\/+$/, "")
}

export function normalizedProvider(provider) {
  const p = String(provider ?? "").trim().toLowerCase()
  return ["social", "enterprise", "gateway", "social_gateway"].includes(p) ? p : "social"
}

export function normalizedStage(stage) {
  const s = String(stage ?? "").trim().toLowerCase()
  return ["prod", "beta", "integ", "dev"].includes(s) ? s : "prod"
}

export const isEnterpriseDiscovery = (provider) => provider === "enterprise" || provider === "gateway"
const isGateway = (provider) => provider === "gateway" || provider === "social_gateway"

const dataPlane = (stage) => endpoints.dataPlaneUrl || SOCIAL_DATA_PLANE[stage] || SOCIAL_DATA_PLANE.prod
const scopesFor = (stage) => SOCIAL_SCOPES[stage] ?? SOCIAL_SCOPES.prod
const oidcEndpoint = (region) => endpoints.oidcBase || `https://oidc.${region}.amazonaws.com`

export function discoveryURL(provider, stage, region, nonce, port, appVersion) {
  const surface = encodeURIComponent(`desktop:${nonce}:${port}:${appVersion}`)
  if (endpoints.discoveryUrl) return `${endpoints.discoveryUrl}?qwSurface=${surface}`
  if (isEnterpriseDiscovery(provider)) {
    let base = ENTERPRISE_DISCOVERY[stage] ?? ENTERPRISE_DISCOVERY.prod
    if (region && region !== "dynamic" && region !== "us-east-1") {
      const u = new URL(base)
      u.host = `${region}.${u.host}`
      base = u.toString()
    }
    return `${base}?qwSurface=${surface}`
  }
  return `${SOCIAL_DISCOVERY[stage] ?? SOCIAL_DISCOVERY.prod}?qwSurface=${surface}`
}

export function redirectURI(provider, port) {
  return isEnterpriseDiscovery(provider) ? `http://localhost:${port}` : `http://127.0.0.1:${port}`
}

// A tenant on these hosts is served by the Gateway, whichever account type
// was picked: <tenant>.<region>.enterprise.quick.aws.com, and with a
// "desktop." label before October 2026. The Gateway has no user-info path
// (it answers 404 UnknownOperationException) and speaks its own framing.
const GATEWAY_ZONE = /\.enterprise\.quick\.aws\.(com|dev)$/i

export function providerFor(provider, tenantUrl) {
  if (provider !== "enterprise") return provider
  const tenant = String(tenantUrl ?? "").trim()
  try {
    return GATEWAY_ZONE.test(new URL(tenant.includes("://") ? tenant : "https://" + tenant).hostname) ? "gateway" : provider
  } catch {
    return provider
  }
}

function userInfoBase(provider, stage, tenantUrl) {
  if (isEnterpriseDiscovery(provider)) return tenantUrl ?? ""
  const tenant = String(tenantUrl ?? "").replace(/\/+$/, "")
  return tenant.includes("dp.appintegrations") ? tenant : dataPlane(stage)
}

const oneLine = (v) => (v === null || v === undefined ? "" : String(v).split(/\s+/).filter(Boolean).join(" "))

function firstValue(raw, ...keys) {
  for (const key of keys) {
    const s = oneLine(raw?.[key])
    if (s) return s
  }
  return ""
}

export function normalizeUserInfo(raw) {
  const src = raw?.userInfo && typeof raw.userInfo === "object" ? raw.userInfo : raw ?? {}
  const pick = (...keys) => firstValue(src, ...keys)
  return {
    email: pick("email", "emailAddress"),
    userName: pick("userName", "user_name", "username"),
    displayName: pick("displayName", "display_name"),
    userArn: pick("userArn", "user_arn"),
    awsAccountId: pick("awsAccountId", "aws_account_id", "accountId"),
    accountName: pick("accountName", "account_name"),
  }
}

export function decodeJWT(token) {
  const part = String(token ?? "").split(".")[1]
  if (!part) return null
  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8"))
    return claims && typeof claims === "object" ? claims : null
  } catch {
    return null
  }
}

function tokensFrom(raw) {
  const expiresIn = Number(raw?.expires_in ?? raw?.expiresIn)
  return {
    accessToken: firstValue(raw, "access_token", "accessToken"),
    refreshToken: firstValue(raw, "refresh_token", "refreshToken"),
    idToken: firstValue(raw, "id_token", "idToken"),
    expiresIn: Number.isFinite(expiresIn) ? Math.trunc(expiresIn) : 0,
  }
}

export class HTTPError extends Error {
  constructor(status, host, body) {
    super(`HTTP ${status} from ${host}: ${body}`)
    this.status = status
    this.body = body
  }
}

async function request(endpoint, init) {
  const host = (() => {
    try {
      return new URL(endpoint).host
    } catch {
      return endpoint
    }
  })()
  const res = await fetch(endpoint, { ...init, signal: init?.signal ?? AbortSignal.timeout(30_000) })
  const text = (await res.text()).slice(0, 1 << 20)
  if (!res.ok) throw new HTTPError(res.status, host, text.trim().slice(0, 300))
  try {
    const value = JSON.parse(text)
    if (value && typeof value === "object") return value
  } catch {}
  throw new Error(`invalid JSON from ${host}`)
}

const postJSON = (endpoint, payload, headers = {}) =>
  request(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...headers },
    body: JSON.stringify(payload),
  })

// What the organization's sign-in server says about itself (RFC 8414); null
// from one that does not say.
async function serverMetadata(authEndpoint) {
  try {
    return await request(`${new URL(authEndpoint).origin}/.well-known/oauth-authorization-server`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    })
  } catch {
    return null
  }
}

// The scopes to ask an organization's sign-in server for: the ones it lists,
// when it lists them and has no OpenID ones.
export function enterpriseScope(metadata) {
  const listed = Array.isArray(metadata?.scopes_supported) ? metadata.scopes_supported.filter((s) => typeof s === "string" && s.trim()) : []
  return listed.length && !listed.includes("openid") ? listed.join(" ") : ENTERPRISE_SCOPE
}

// The tenant as the audience of the sign-in (RFC 8707): https://<host>,
// without a port or a path. An organization's sign-in server answers
// "Missing or invalid resource parameter" to a request without it.
export function resourceFor(tenantUrl) {
  const tenant = String(tenantUrl ?? "").trim()
  if (!tenant) return ""
  try {
    const u = new URL(tenant.includes("://") ? tenant : "https://" + tenant)
    return `${u.protocol}//${u.hostname}`
  } catch {
    return ""
  }
}

const postForm = (endpoint, form) =>
  request(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  })

// Who the tokens say the account is, for a Gateway tenant, which has no
// user-info to ask. The claims of such a token are not documented, so the
// usual names are read and whatever is missing stays empty.
export function claimedUserInfo(tokens) {
  const claims = { ...decodeJWT(tokens?.accessToken), ...decodeJWT(tokens?.idToken) }
  const text = (...keys) => keys.map((k) => claims[k]).find((v) => typeof v === "string" && v.trim())?.trim() ?? ""
  const arn = [text("userArn", "user_arn", "actor_arn"), text("sub")].find((v) => v.startsWith("arn:")) ?? ""
  const account = text("awsAccountId", "aws_account_id", "accountId", "account_id")
  return {
    email: text("email", "emailAddress") || (text("preferred_username").includes("@") ? text("preferred_username") : ""),
    userName: text("userName", "user_name", "username", "preferred_username"),
    displayName: text("displayName", "display_name", "name"),
    userArn: arn,
    awsAccountId: /^\d{12}$/.test(account) ? account : /^arn:[^:]*:[^:]*:[^:]*:(\d{12}):/.exec(arn)?.[1] ?? "",
    accountName: text("accountName", "account_name"),
  }
}

const unknownOperation = (e) => e instanceof HTTPError && e.status === 404 && /UnknownOperation/i.test(e.body)

// The account's details and the provider it turned out to be: an
// organization's tenant that answers user-info as the Gateway does (404
// UnknownOperationException) is one, whatever its host is called.
async function fetchUserInfo(provider, stage, tenantUrl, tokens) {
  if (!tokens.accessToken) throw new Error("token response has no access_token")
  if (isGateway(provider)) return { provider, info: claimedUserInfo(tokens) }
  const base = userInfoBase(provider, stage, tenantUrl).replace(/\/+$/, "")
  if (!base) throw new Error("discovery response has no tenant_url")
  try {
    const raw = await postJSON(`${base}/integration/quick-work/user-info`, {}, { authorization: `Bearer ${tokens.accessToken}` })
    return { provider, info: normalizeUserInfo(raw) }
  } catch (e) {
    if (provider !== "enterprise" || !unknownOperation(e)) throw e
    return { provider: "gateway", info: claimedUserInfo(tokens) }
  }
}

const prefer = (value, fallback) => (String(value ?? "").trim() ? value : fallback ?? "")

const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isDeviceId = (value) => typeof value === "string" && DEVICE_ID.test(value)

// Builds the fields saved for an account from newly obtained tokens. `base`
// carries the account's provider, tenant URL and OAuth client.
export function sessionFields(base, tokens, info) {
  const access = tokens.accessToken.trim()
  const idToken = tokens.idToken.trim()
  if (!idToken && !access) throw new Error("token response has no id_token/access_token")

  let tenant = String(base.tenantUrl ?? "").trim() || dataPlane(base.stage)
  tenant = tenant.replace(/\/+$/, "")
  if (!tenant.includes("://")) tenant = "https://" + tenant
  let parsed
  try {
    parsed = new URL(tenant)
  } catch {}
  if (!parsed?.host) throw new Error(`cannot derive ws_host from tenant_url ${JSON.stringify(tenant)}`)

  const claims = decodeJWT(idToken) ?? decodeJWT(access)
  const sub = typeof claims?.sub === "string" ? claims.sub : ""
  const actorArn = info.userArn.trim() || (sub.startsWith("arn:") ? sub : "")
  const region = String(base.region ?? "").trim() || (typeof claims?.region === "string" ? claims.region : "") || "us-east-1"

  let expires = 0
  if (tokens.expiresIn > 0) expires = Date.now() + tokens.expiresIn * 1000
  else if (Number(claims?.exp) > 0) expires = Number(claims.exp) * 1000

  const email = prefer(info.email, base.email)
  const displayName = prefer(info.displayName, base.displayName)
  const accountName = prefer(info.accountName, base.accountName)
  return {
    type: "oauth",
    access,
    refresh: tokens.refreshToken.trim() || base.refresh || "",
    expires,
    idToken,
    accountId: email || info.userName || displayName || actorArn || base.accountId || parsed.hostname,
    email,
    displayName,
    accountName,
    actorArn: prefer(actorArn, base.actorArn),
    awsAccountId: prefer(info.awsAccountId || (typeof claims?.aws_account_id === "string" ? claims.aws_account_id : ""), base.awsAccountId),
    quickProvider: base.quickProvider,
    stage: base.stage,
    region,
    tenantUrl: tenant,
    // a plain-http tenant is a local mock: keep it off TLS
    wsHost: parsed.protocol === "http:" ? `ws://${parsed.host}` : parsed.host,
    wsPath: isGateway(base.quickProvider) ? GATEWAY_WS_PATH : "",
    clientId: base.clientId ?? "",
    clientSecret: base.clientSecret ?? "",
    issuerUrl: base.issuerUrl ?? "",
    idcRegion: base.idcRegion ?? "",
    tokenEndpoint: base.tokenEndpoint ?? "",
    redirectUri: base.redirectUri ?? "",
    // What the desktop app calls its device id, sent as outpostId. An
    // account gets one when it signs in, or with its next renewal when it
    // signed in before there was one, and keeps it from then on.
    deviceId: isDeviceId(base.deviceId) ? base.deviceId : randomUUID(),
  }
}

const REFUSED = /invalid_(grant|client)|InvalidGrant|InvalidClient|UnauthorizedClient|unauthorized_client|ExpiredToken|expired/i
const expired = (message) => Object.assign(new Error(message), { signIn: "expired" })

// Renews an account's tokens and returns its updated fields. A refresh the
// identity provider refuses is thrown with signIn: "expired".
export async function refresh(auth) {
  const token = String(auth?.refresh ?? "").trim()
  if (!token || token === "none") throw expired("Amazon Quick: no refresh token is stored; sign in again")
  const provider = providerFor(normalizedProvider(auth.quickProvider), auth.tenantUrl)

  let raw
  try {
    if (isEnterpriseDiscovery(provider)) {
      if (!auth.tokenEndpoint) throw expired("Amazon Quick: the account has no token endpoint; sign in again")
      const form = { grant_type: "refresh_token", refresh_token: token, client_id: auth.clientId ?? "" }
      if (auth.clientSecret) form.client_secret = auth.clientSecret
      const resource = resourceFor(auth.tenantUrl)
      if (resource) form.resource = resource
      raw = await postForm(auth.tokenEndpoint, form)
    } else {
      const endpoint = auth.tokenEndpoint || `${oidcEndpoint(auth.idcRegion || auth.region || "us-east-1")}/token`
      raw = await postJSON(endpoint, {
        clientId: auth.clientId,
        clientSecret: auth.clientSecret,
        grantType: "refresh_token",
        refreshToken: token,
      })
    }
  } catch (e) {
    // the identity provider refusing the refresh token or the registered
    // client; any other failure may pass, so the account is left alone
    const refused = e instanceof HTTPError && (e.status === 401 || (e.status === 400 && REFUSED.test(e.body)))
    if (refused) throw expired(`Amazon Quick refused the sign-in; sign in again (${e.message})`)
    throw e
  }
  const tokens = tokensFrom(raw)
  if (!tokens.accessToken) throw new Error("refresh returned no access_token")
  const who = await fetchUserInfo(provider, normalizedStage(auth.stage), auth.tenantUrl, tokens)
  return sessionFields({ ...auth, quickProvider: who.provider, stage: normalizedStage(auth.stage) }, tokens, who.info)
}

const randomToken = () => randomBytes(32).toString("base64url")

function sameSecret(a, b) {
  const x = Buffer.from(String(a ?? ""))
  const y = Buffer.from(String(b ?? ""))
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y)
}

function appendQuery(endpoint, params) {
  const u = new URL(endpoint)
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  return u.toString()
}

export class StepError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

// One browser sign-in. It is plain data plus methods, so a manual login can
// be saved between its two steps (toJSON / LoginFlow.from).
export class LoginFlow {
  constructor({ provider, stage, region, port, appVersion }) {
    this.provider = normalizedProvider(provider)
    this.stage = normalizedStage(stage)
    this.region = String(region ?? "").trim()
    this.port = port
    this.appVersion = appVersion
    this.redirectUri = redirectURI(this.provider, port)
    this.state = randomToken()
    this.nonce = randomToken()
    this.verifier = randomToken()
    this.discovery = null
    this.clientId = ""
    this.clientSecret = ""
    this.resource = ""
    this.authorizeUrl = ""
    this.created = Date.now()
  }

  static from(saved) {
    return Object.assign(Object.create(LoginFlow.prototype), saved)
  }

  toJSON() {
    return { ...this }
  }

  get challenge() {
    return createHash("sha256").update(this.verifier).digest("base64url")
  }

  get loginUrl() {
    return discoveryURL(this.provider, this.stage, this.region, this.nonce, this.port, this.appVersion)
  }

  // Validates the browser's discovery callback and returns the authorize URL
  // the user must open next.
  async processDiscovery(query) {
    const q = (...keys) => {
      for (const key of keys) {
        const v = String(query.get(key) ?? "").trim()
        if (v) return v
      }
      return ""
    }
    if (!sameSecret(query.get("nonce"), this.nonce)) throw new StepError(400, "discovery nonce mismatch")
    if (query.get("error")) throw new StepError(400, `login failed: ${query.get("error")} ${query.get("error_description") ?? ""}`.trim())
    if (this.authorizeUrl) return this.authorizeUrl

    const pkce = { code_challenge: this.challenge, code_challenge_method: "S256" }
    if (isEnterpriseDiscovery(this.provider)) {
      this.discovery = {
        authEndpoint: q("authEndpoint", "auth_endpoint"),
        tokenEndpoint: q("tokenEndpoint", "token_endpoint"),
        issuerUrl: q("issuer"),
        tenantUrl: q("tenantUrl", "tenant_url"),
        region: q("region"),
        idcRegion: "",
      }
      if (!this.discovery.authEndpoint || !this.discovery.tokenEndpoint)
        throw new StepError(400, "discovery response is missing authEndpoint/tokenEndpoint")
      this.provider = providerFor(this.provider, this.discovery.tenantUrl)
      this.clientId = q("clientId", "client_id")
      this.clientSecret = q("clientSecret", "client_secret")
      this.resource = q("resource") || resourceFor(this.discovery.tenantUrl)
      const params = {
        response_type: "code",
        client_id: this.clientId,
        redirect_uri: this.redirectUri,
        scope: enterpriseScope(await serverMetadata(this.discovery.authEndpoint)),
        state: this.state,
        ...pkce,
        access_type: "offline",
        prompt: "consent",
      }
      if (this.resource) params.resource = this.resource
      this.authorizeUrl = appendQuery(this.discovery.authEndpoint, params)
      return this.authorizeUrl
    }

    const issuerUrl = q("issuerUrl", "issuer_url", "issuer")
    if (!issuerUrl) throw new StepError(400, "discovery callback did not provide issuerUrl")
    const idcRegion = q("idcRegion", "idc_region") || this.region || "us-east-1"
    this.discovery = {
      authEndpoint: "",
      tokenEndpoint: "",
      issuerUrl,
      tenantUrl: q("tenantUrl", "tenant_url"),
      region: this.region,
      idcRegion,
    }
    let client
    try {
      client = await postJSON(`${oidcEndpoint(idcRegion)}/client/register`, {
        clientName: "AmazonQuick-Desktop",
        clientType: "public",
        scopes: scopesFor(this.stage),
        grantTypes: ["authorization_code", "refresh_token"],
        redirectUris: [this.redirectUri],
        issuerUrl,
      })
    } catch (e) {
      throw new StepError(502, `client registration failed: ${e.message}`)
    }
    this.clientId = firstValue(client, "clientId", "client_id")
    this.clientSecret = firstValue(client, "clientSecret", "client_secret")
    if (!this.clientId) throw new StepError(502, "client registration returned no clientId")
    this.authorizeUrl = appendQuery(`${oidcEndpoint(idcRegion)}/authorize`, {
      response_type: "code",
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: scopesFor(this.stage).join(" "),
      state: this.state,
      ...pkce,
    })
    return this.authorizeUrl
  }

  async exchangeCode(code) {
    if (isEnterpriseDiscovery(this.provider)) {
      const form = {
        grant_type: "authorization_code",
        code,
        redirect_uri: this.redirectUri,
        client_id: this.clientId,
        code_verifier: this.verifier,
      }
      if (this.clientSecret) form.client_secret = this.clientSecret
      if (this.resource) form.resource = this.resource
      return tokensFrom(await postForm(this.discovery.tokenEndpoint, form))
    }
    return tokensFrom(
      await postJSON(`${oidcEndpoint(this.discovery.idcRegion)}/token`, {
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        grantType: "authorization_code",
        code,
        redirectUri: this.redirectUri,
        codeVerifier: this.verifier,
      }),
    )
  }

  // Exchanges the OAuth code and returns the fields to save for the account.
  async complete(query) {
    if (query.get("error")) throw new StepError(400, `login failed: ${query.get("error")} ${query.get("error_description") ?? ""}`.trim())
    if (!this.authorizeUrl || !this.discovery) throw new StepError(400, "the discovery step has not been completed yet")
    if (!sameSecret(query.get("state"), this.state)) throw new StepError(400, "OAuth state mismatch")
    const code = query.get("code")
    if (!code) throw new StepError(400, "OAuth callback has no code")

    let tokens
    try {
      tokens = await this.exchangeCode(code)
    } catch (e) {
      throw new StepError(502, `token exchange failed: ${e.message}`)
    }
    let info
    try {
      const who = await fetchUserInfo(this.provider, this.stage, this.discovery.tenantUrl, tokens)
      this.provider = who.provider
      info = who.info
    } catch (e) {
      throw new StepError(502, `user info failed: ${e.message}`)
    }
    const d = this.discovery
    return sessionFields(
      {
        quickProvider: this.provider,
        stage: this.stage,
        region: d.region || this.region,
        tenantUrl: d.tenantUrl,
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        issuerUrl: d.issuerUrl,
        idcRegion: d.idcRegion,
        tokenEndpoint: d.tokenEndpoint || `${oidcEndpoint(d.idcRegion)}/token`,
        redirectUri: this.redirectUri,
      },
      tokens,
      info,
    )
  }
}
