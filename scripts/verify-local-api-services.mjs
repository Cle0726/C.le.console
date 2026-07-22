import fs from 'node:fs';
import path from 'node:path';

const home = process.env.USERPROFILE || process.env.HOME;
const dataDir = process.env.CLE_CONSOLE_DATA_DIR || path.join(home, '.antigravity_cle');
const mode = process.argv.includes('--all') ? 'all' : 'representative';
const reportPath = path.resolve('target', `api-verification-${mode}.json`);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function request(name, url, init = {}, timeoutMs = 90_000) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    const errorText = response.ok ? null : JSON.stringify(body).slice(0, 800);
    return {
      name,
      ok: response.ok,
      status: response.status,
      latencyMs: Date.now() - started,
      error: errorText,
      body,
    };
  } catch (error) {
    return {
      name,
      ok: false,
      status: 0,
      latencyMs: Date.now() - started,
      error: String(error?.cause?.message || error?.message || error).slice(0, 800),
      body: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function contractRequest(name, url, init, acceptedStatuses, timeoutMs = 15_000) {
  const result = await request(name, url, init, timeoutMs);
  const accepted = acceptedStatuses.includes(result.status);
  return {
    ...result,
    ok: accepted,
    error: accepted ? null : (result.error || `unexpected status ${result.status}`),
  };
}

function bearer(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

function summarized(result) {
  return {
    name: result.name,
    ok: result.ok,
    status: result.status,
    latencyMs: result.latencyMs,
    error: result.error,
  };
}

const multi = readJson(path.join(dataDir, 'multi_model_api_service.json'));
const multiKey = multi.apiKeys.find((item) => item.enabled && item.key)?.key;
const codex = readJson(path.join(dataDir, 'codex_local_access.json'));
const codexKeys = [...new Set([
  ...(codex.apiKeys || []).filter((item) => item.enabled && item.key).map((item) => item.key),
  codex.apiKey,
].filter(Boolean))];
let codexKey = codexKeys[0];
const auroraKeyPath = 'F:\\自动注册\\AuroraProxy\\new_api_key.txt';
const auroraKey = fs.existsSync(auroraKeyPath) ? fs.readFileSync(auroraKeyPath, 'utf8').trim() : '';
const chatToken = multi.accounts.find((item) => item.enabled && item.provider === 'codex' && item.credentialJson?.access_token)?.credentialJson?.access_token;

const results = [];
const catalogs = {};

const multiModels = await request('multi.models', 'http://127.0.0.1:1466/v1/models', {
  headers: bearer(multiKey),
}, 15_000);
results.push(summarized(multiModels));
catalogs.multi = Array.isArray(multiModels.body?.data) ? multiModels.body.data.map((item) => item.id).sort() : [];

let codexModels;
for (const candidate of codexKeys.length ? codexKeys : ['']) {
  codexModels = await request('codex.models', 'http://127.0.0.1:4479/v1/models', {
    headers: bearer(candidate),
  }, 15_000);
  codexKey = candidate;
  if (codexModels.status !== 401 && codexModels.status !== 403) break;
}
results.push(summarized(codexModels));
catalogs.codex = Array.isArray(codexModels.body?.data) ? codexModels.body.data.map((item) => item.id).sort() : [];

const auroraModels = await request('aurora.models', 'http://127.0.0.1:8080/v1/models', {
  headers: bearer(auroraKey),
}, 15_000);
results.push(summarized(auroraModels));
catalogs.aurora = Array.isArray(auroraModels.body?.data) ? auroraModels.body.data.map((item) => item.id).sort() : [];

const chatTokens = await request('chat2api.tokens', 'http://127.0.0.1:5005/tokens', {}, 15_000);
results.push(summarized(chatTokens));

const representativeModels = [
  'grok-3-mini-fast',
  'gpt-5.4-mini',
  'gemini-2.5-flash',
  'claude-3-5-haiku-latest',
];

const configuredTextModels = [...new Set(multi.accounts
  .filter((account) => account.enabled)
  .flatMap((account) => account.models || [])
  .filter((model) => model.enabled && (model.capabilities || []).includes('text'))
  .map((model) => model.alias?.trim() || model.id))].sort();

const selectedModels = mode === 'all' ? configuredTextModels : representativeModels;
for (const model of selectedModels) {
  const result = await request(`multi.chat.${model}`, 'http://127.0.0.1:1466/v1/chat/completions', {
    method: 'POST',
    headers: bearer(multiKey),
    body: JSON.stringify({
      model,
      stream: false,
      max_tokens: 8,
      messages: [{ role: 'user', content: 'Reply with exactly OK.' }],
    }),
  });
  results.push(summarized(result));
}

// Exercise every public compatibility surface with one real request. These
// checks catch route-registration and translation regressions that /v1/models
// and the OpenAI chat endpoint alone cannot detect.
const responsesModel = catalogs.multi.find((id) => id === 'gpt-5.4-mini')
  || catalogs.multi.find((id) => /^gpt-/.test(id));
if (responsesModel) {
  const result = await request(`multi.responses.${responsesModel}`, 'http://127.0.0.1:1466/v1/responses', {
    method: 'POST', headers: bearer(multiKey),
    body: JSON.stringify({ model: responsesModel, stream: false, max_output_tokens: 8, input: 'Reply with exactly OK.' }),
  });
  results.push(summarized(result));
}

const claudeModel = catalogs.multi.find((id) => /^claude-/.test(id));
if (claudeModel) {
  const result = await request(`multi.messages.${claudeModel}`, 'http://127.0.0.1:1466/v1/messages', {
    method: 'POST',
    headers: { ...bearer(multiKey), 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: claudeModel, max_tokens: 8, messages: [{ role: 'user', content: 'Reply with exactly OK.' }] }),
  });
  results.push(summarized(result));
}

const geminiModel = catalogs.multi.find((id) => /^gemini-/.test(id));
if (geminiModel) {
  const result = await request(`multi.generateContent.${geminiModel}`, `http://127.0.0.1:1466/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent`, {
    method: 'POST', headers: bearer(multiKey),
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply with exactly OK.' }] }], generationConfig: { maxOutputTokens: 8 } }),
  });
  results.push(summarized(result));
}

// Validate image/video wrappers without starting billable long-running media
// jobs: a missing prompt must be rejected by the local public wrapper rather
// than falling through as 404/500 or reaching an upstream provider.
for (const endpoint of ['images/generations', 'videos/generations']) {
  const result = await contractRequest(`multi.contract.${endpoint}`, `http://127.0.0.1:1466/v1/${endpoint}`, {
    method: 'POST', headers: bearer(multiKey), body: JSON.stringify({}),
  }, [400, 422]);
  results.push(summarized(result));
}

const cors = await contractRequest('multi.cors.responses', 'http://127.0.0.1:1466/v1/responses', {
  method: 'OPTIONS',
  headers: { Origin: 'http://127.0.0.1', 'Access-Control-Request-Method': 'POST' },
}, [200, 204]);
results.push(summarized(cors));

const firstCodexModel = catalogs.codex.find((id) => /^gpt-/.test(id));
if (firstCodexModel) {
  const result = await request(`codex.chat.${firstCodexModel}`, 'http://127.0.0.1:4479/v1/chat/completions', {
    method: 'POST', headers: bearer(codexKey),
    body: JSON.stringify({ model: firstCodexModel, stream: false, max_tokens: 8, messages: [{ role: 'user', content: 'Reply with exactly OK.' }] }),
  });
  results.push(summarized(result));
}

const firstAuroraModel = catalogs.aurora.find((id) => id === 'gpt-4o-mini')
  || catalogs.aurora.find((id) => id !== 'auto');
if (firstAuroraModel) {
  const result = await request(`aurora.chat.${firstAuroraModel}`, 'http://127.0.0.1:8080/v1/chat/completions', {
    method: 'POST', headers: bearer(auroraKey),
    body: JSON.stringify({ model: firstAuroraModel, stream: false, max_tokens: 8, messages: [{ role: 'user', content: 'Reply with exactly OK.' }] }),
  });
  results.push(summarized(result));
}

if (chatToken) {
  const result = await request('chat2api.chat.gpt-4o-mini', 'http://127.0.0.1:5005/v1/chat/completions', {
    method: 'POST', headers: bearer(chatToken),
    body: JSON.stringify({ model: 'gpt-4o-mini', stream: false, max_tokens: 8, messages: [{ role: 'user', content: 'Reply with exactly OK.' }] }),
  });
  results.push(summarized(result));
}

const report = {
  generatedAt: new Date().toISOString(),
  mode,
  summary: {
    total: results.length,
    passed: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
  },
  catalogs,
  results,
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ reportPath, ...report.summary, results }, null, 2));
process.exitCode = report.summary.failed ? 1 : 0;
