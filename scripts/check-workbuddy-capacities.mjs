// Read-only capacity check. No chat, Responses, model generation or credit spend.
// Usage: node scripts/check-workbuddy-capacities.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.join(os.homedir(), '.antigravity_cle');
const config = JSON.parse(fs.readFileSync(path.join(root, 'multi_model_api_service.json'), 'utf8'));
const routes = config.accounts.filter((route) => route.provider === 'workbuddy' && route.enabled);
assert(routes.length, '未接入 WorkBuddy 账号');
const key = config.apiKeys.find((item) => item.enabled && !item.providerGateway && !item.modelPrefix && !item.allowedModels?.length && !item.accountIds?.length);
assert(key, '没有可用于目录检查的现有 unrestricted Key；不会扩大 Key 权限');
const base = `http://127.0.0.1:${config.port}`;
const headers = { Authorization: `Bearer ${key.key}` };
async function directory(url) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  assert(response.ok, `目录读取失败 HTTP ${response.status}`);
  return response.json();
}
const ordinary = new Map((await directory(`${base}/v1/models`)).data.map((model) => [model.id, model]));
const codex = new Map((await directory(`${base}/v1/models?client_version=capacity-check`)).models.map((model) => [model.slug, model]));
const capacities = new Map();
for (const route of routes) {
  const account = JSON.parse(fs.readFileSync(path.join(root, 'workbuddy_accounts', `${route.source.slice('cle:workbuddy:'.length)}.json`), 'utf8'));
  const upstream = /workbuddy\.ai$/.test(account.domain || '') ? 'https://www.workbuddy.ai' : 'https://copilot.tencent.com';
  const response = await fetch(`${upstream}/v2/enterprises/${account.enterprise_id || 'personal'}/models`, {
    signal: AbortSignal.timeout(30000), headers: {
      Authorization: `Bearer ${account.access_token}`, 'X-User-Id': account.uid,
      'X-Domain': upstream.slice('https://'.length), 'X-Product': 'WorkBuddy',
      'X-IDE-Name': 'WorkBuddy', 'X-IDE-Type': 'WorkBuddy', 'X-Agent-Purpose': 'conversation',
      'User-Agent': 'WorkBuddy/5.4.5',
    },
  });
  assert(response.ok, `官方目录读取失败 HTTP ${response.status}`);
  const body = await response.json();
  assert(body.code === 0 || body.code === 200, '官方目录业务错误');
  const models = new Map(body.data.models.map((model) => [model.id, model]));
  for (const saved of route.models.filter((model) => model.enabled)) {
    const model = models.get(saved.id.slice('workbuddy/'.length));
    assert(model, `${saved.id} 已不在上游目录`);
    const input = Number(model.maxInputTokens) || 0;
    const selectable = (model.contextWindow?.supportedLengths || []).filter((value) => value > 0 && (!input || value <= input));
    const maximum = selectable.length ? Math.max(...selectable) : input;
    const output = Number(model.maxOutputTokens) || 0;
    assert.equal(saved.maxInputTokens, maximum, `${saved.id} 保存容量未按上游最大值同步`);
    assert.equal(saved.maxOutputTokens, output, `${saved.id} 保存输出容量丢失`);
    const old = capacities.get(saved.id);
    capacities.set(saved.id, { input: old ? Math.min(old.input, maximum) : maximum, output: old ? Math.min(old.output, output) : output });
  }
}
for (const [id, expected] of capacities) {
  assert.equal(ordinary.get(id)?.context_length, expected.input, `${id} OpenAI 目录容量错误`);
  assert.equal(ordinary.get(id)?.max_output_tokens, expected.output, `${id} OpenAI 输出容量错误`);
  assert.equal(codex.get(id)?.context_window, expected.input, `${id} Codex 目录仍使用默认容量`);
  assert.equal(codex.get(id)?.max_context_window, expected.input, `${id} Codex 最大容量错误`);
  console.log(JSON.stringify({ model: id, maxInputTokens: expected.input, maxOutputTokens: expected.output, inferenceRequests: 0 }));
}
console.log(JSON.stringify({ result: 'READ_ONLY_CAPACITY_PASS', accounts: routes.length, models: capacities.size, inferenceRequests: 0 }));
