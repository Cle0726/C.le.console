/** C.le owns and refreshes credentials. A CLI request receives only its
 * short-lived access token; it never receives the refresh token or bridge key. */
export async function cleChildEnvironment(): Promise<NodeJS.ProcessEnv> {
  const url = process.env.CLE_CREDENTIAL_URL;
  if (!url) return { ...process.env, OPENCLAW_PROXY: "1" };

  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("C.le 凭证地址无效"); }
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" ||
      parsed.username || parsed.password || parsed.search || parsed.hash ||
      !/^\/credentials\/claude~[A-Za-z0-9_-]+$/.test(parsed.pathname)) {
    throw new Error("C.le 凭证地址必须指向本机 Claude 账号");
  }
  const key = process.env.CLE_CREDENTIAL_KEY;
  if (!key) throw new Error("C.le 凭证桥未授权");
  let response: Response;
  try {
    response = await fetch(parsed, {
      headers: { Authorization: `Bearer ${key}` },
      redirect: "error",
      signal: AbortSignal.timeout(50_000),
    });
  } catch { throw new Error("无法连接 C.le 凭证服务"); }
  if (!response.ok) throw new Error("Claude 账号登录已失效，请在 C.le 中重新登录");
  if (Number(response.headers.get("content-length") || 0) > 65536) {
    throw new Error("C.le 凭证响应过大");
  }
  let data: { metadata?: { access_token?: unknown } };
  try {
    const raw = await response.text();
    if (raw.length > 65536) throw new Error("too large");
    data = JSON.parse(raw);
  } catch { throw new Error("C.le 凭证响应无效"); }
  const token = data?.metadata?.access_token;
  if (typeof token !== "string" || !token.trim()) throw new Error("Claude 账号缺少有效凭证");

  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith("CLE_") || name.startsWith("ANTHROPIC_") ||
        name.startsWith("CLAUDE_CODE_") || name.startsWith("CLAUDE_PROXY_") ||
        name === "CLAUDECODE" || name === "CLAUDE_CONFIG_DIR" ||
        name === "CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS") continue;
    env[name] = value;
  }
  env.CLAUDE_CODE_OAUTH_TOKEN = token;
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.OPENCLAW_PROXY = "1";
  return env;
}
