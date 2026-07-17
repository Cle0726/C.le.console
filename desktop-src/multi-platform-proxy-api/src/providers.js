export const providerAdapters = new Map([
  ['openai_compatible', openAICompatibleAdapter()],
  ['custom_http', openAICompatibleAdapter()],
  ['claude_web', unsupportedWebAdapter('claude_web')],
  ['gemini_web', unsupportedWebAdapter('gemini_web')],
  ['yuanbao_web', unsupportedWebAdapter('yuanbao_web')],
  ['kimi_web', unsupportedWebAdapter('kimi_web')],
]);

function openAICompatibleAdapter() {
  return {
    async chatCompletions(request, ctx) {
      const payload = await postJson('chat/completions', { ...request, model: ctx.upstreamModel }, ctx);
      return normalizeChatResponse(payload, request.model, ctx.upstreamModel);
    },
    async imagesGenerations(request, ctx) {
      const payload = await postJson('images/generations', { ...request, model: ctx.upstreamModel }, ctx);
      return normalizeImageResponse(payload, request.model, ctx.upstreamModel);
    },
    async responses(request, ctx) {
      const payload = await postJson('responses', { ...request, model: ctx.upstreamModel }, ctx);
      return normalizeResponsesResponse(payload, request.model, ctx.upstreamModel);
    },
    classifyError,
  };
}

async function postJson(endpoint, request, ctx) {
  if (!ctx.provider.baseUrl) throw new Error(`provider ${ctx.provider.id} missing baseUrl`);
  const apiKey = resolveApiKey(ctx.account);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.timeoutMs || 120000);
  try {
    const response = await fetch(`${ctx.provider.baseUrl.replace(/\/+$/, '')}/${endpoint}`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...(ctx.account.auth?.headers || {}),
      },
      body: JSON.stringify(request),
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(text || `upstream HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return text ? safeJsonParse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

function unsupportedWebAdapter(kind) {
  return {
    async chatCompletions() {
      const error = new Error(`${kind} adapter placeholder: browser/session transport not implemented in MVP yet`);
      error.status = 501;
      throw error;
    },
    async imagesGenerations() {
      const error = new Error(`${kind} adapter placeholder: image generation transport not implemented in MVP yet`);
      error.status = 501;
      throw error;
    },
    async responses() {
      const error = new Error(`${kind} adapter placeholder: responses transport not implemented in MVP yet`);
      error.status = 501;
      throw error;
    },
    classifyError,
  };
}

function resolveApiKey(account) {
  const auth = account.auth || {};
  if (auth.apiKey) return auth.apiKey;
  if (auth.apiKeyEnv && process.env[auth.apiKeyEnv]) return process.env[auth.apiKeyEnv];
  if (auth.sessionKey) return auth.sessionKey;
  return '';
}

function normalizeChatResponse(payload, requestedModel, upstreamModel) {
  if (payload?.choices?.[0]?.message) {
    return { ...payload, model: requestedModel || payload.model || upstreamModel };
  }
  const content = payload?.text || payload?.content || JSON.stringify(payload);
  return {
    id: `chatcmpl-local-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel || upstreamModel,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: payload?.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function normalizeImageResponse(payload, requestedModel, upstreamModel) {
  const data = Array.isArray(payload?.data)
    ? payload.data
    : payload?.b64_json || payload?.url
      ? [payload]
      : [];
  return {
    ...payload,
    created: payload?.created || Math.floor(Date.now() / 1000),
    model: requestedModel || payload?.model || upstreamModel,
    data,
  };
}

function normalizeResponsesResponse(payload, requestedModel, upstreamModel) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return {
      ...payload,
      model: requestedModel || payload.model || upstreamModel,
    };
  }
  return {
    id: `resp-local-${Date.now()}`,
    object: 'response',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel || upstreamModel,
    output_text: typeof payload === 'string' ? payload : JSON.stringify(payload),
    output: [],
  };
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export function classifyError(error) {
  const status = error?.status;
  const message = error instanceof Error ? error.message : String(error);
  if (status === 401 || status === 403) return 'invalid_session';
  if (status === 404) return 'model_not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'upstream_5xx';
  if (status >= 400) return 'upstream_4xx';
  if (/quota|insufficient|exhaust/i.test(message)) return 'quota_exceeded';
  if (/cloudflare/i.test(message)) return 'cloudflare_block';
  if (/risk|captcha|verify/i.test(message)) return 'risk_control_block';
  if (/timeout|aborted|ECONNRESET|ENOTFOUND|fetch failed/i.test(message)) return 'network_error';
  return 'unknown';
}
