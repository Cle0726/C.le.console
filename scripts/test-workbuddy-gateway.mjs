// Explicit live acceptance test: sends a few small requests through the installed
// C.le gateway, and checks official credits without printing keys or login tokens.
// Usage: node scripts/test-workbuddy-gateway.mjs --run [--data-dir PATH]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

if (!process.argv.includes('--run')) throw new Error('需要 --run：此测试会真实调用 WorkBuddy，并消耗少量积分。');
const dataFlag = process.argv.indexOf('--data-dir');
const dataDir = dataFlag >= 0 ? process.argv[dataFlag + 1] : path.join(os.homedir(), '.antigravity_cle');
const creditWaitFlag = process.argv.indexOf('--credit-wait-seconds');
const creditWaitSeconds = creditWaitFlag >= 0 ? Number(process.argv[creditWaitFlag + 1]) : 300;
assert(Number.isFinite(creditWaitSeconds) && creditWaitSeconds >= 0 && creditWaitSeconds <= 600, '扣费查询等待时间必须在 0–600 秒之间');
const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'multi_model_api_service.json'), 'utf8'));
const key = config.apiKeys.find((item) => item.enabled && !item.providerGateway && !item.modelPrefix && !item.allowedModels?.length && !item.accountIds?.length);
assert(key, '测试需要一个不限账号、不限模型的现有网关 Key；不会自动扩大 Key 权限');
const base = `http://127.0.0.1:${config.port}`;
const accounts = config.accounts.filter((item) => item.enabled && item.provider === 'workbuddy');
assert(accounts.length >= 2, '至少同步两个 WorkBuddy 账号，才能验证真实账号轮询');
let version = '5.5.6';
if (process.platform === 'darwin') {
  try { version = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', '/Applications/WorkBuddy.app/Contents/Info.plist'], { encoding: 'utf8' }).trim(); } catch {}
}

async function balance(route) {
  const id = route.source.slice('cle:workbuddy:'.length);
  const account = JSON.parse(fs.readFileSync(path.join(dataDir, 'workbuddy_accounts', `${id}.json`), 'utf8'));
  let response;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await fetch('https://www.codebuddy.cn/v2/billing/meter/get-user-resource', {
    method: 'POST', signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${account.access_token}`, 'X-User-Id': account.uid, 'X-Domain': account.domain || 'copilot.tencent.com', 'Content-Type': 'application/json', 'User-Agent': `WorkBuddy/${version}`, 'X-Product': 'SaaS', 'X-CodeBuddy-Request': '1', Origin: 'https://www.codebuddy.cn', Referer: 'https://www.codebuddy.cn/' },
    body: JSON.stringify({ ProductCode: 'p_tcaca', Status: [0, 3], PageNumber: 1, PageSize: 100 }),
      });
      break;
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
  const body = await response.json();
  assert(response.ok && (body.code === 0 || body.code === 200), `余额查询失败 HTTP ${response.status}, code ${body.code}`);
  const resources = body.data?.Response?.Data?.Accounts;
  assert(Array.isArray(resources), '余额缺少 Accounts，不能伪造零积分');
  return resources.filter((item) => item.Status === 0 || item.Status === 3).reduce((sum, item) => sum + Number(item.CycleCapacityRemainPrecise ?? item.CycleCapacityRemain ?? item.CapacityRemainPrecise ?? item.CapacityRemain ?? 0), 0);
}

async function request(endpoint, body) {
  const started = Date.now();
  const response = await fetch(`${base}${endpoint}`, { method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(90000), headers: { Authorization: `Bearer ${key.key}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  assert(response.ok, `网关 ${endpoint} HTTP ${response.status}: ${text.slice(0, 500)}`);
  return { text, latencyMs: Date.now() - started, status: response.status };
}

const catalog = JSON.parse((await request('/v1/models')).text).data.map((model) => model.id);
const models = catalog.filter((id) => id.startsWith('workbuddy/'));
assert(models.includes('workbuddy/hy3'), '网关未暴露真实 WorkBuddy hy3 模型');
console.log(JSON.stringify({ phase: 'catalog', enabledAccounts: accounts.length, workbuddyModels: models.length }));
const balancesBefore = await Promise.all(accounts.map(balance));
console.log(JSON.stringify({ phase: 'credits_before', balances: balancesBefore }));
const messages = [{ role: 'user', content: '只回复 OK，不要解释。' }];
const results = [];
for (const stream of [false, true]) {
  const result = await request('/v1/chat/completions', { model: 'workbuddy/hy3', messages, stream, max_tokens: 256 });
  if (stream) {
    const chunks = result.text.split('\n').filter((line) => line.startsWith('data: ') && !line.includes('[DONE]')).map((line) => JSON.parse(line.slice(6)));
    assert(chunks.map((chunk) => chunk.choices?.[0]?.delta?.content || '').join('').includes('OK'), '流式未返回真实回答');
    assert(chunks.some((chunk) => chunk.choices?.[0]?.finish_reason === 'stop'), '流式没有正常结束');
    assert(result.text.includes('[DONE]'), '流式缺少 DONE');
  } else {
    const body = JSON.parse(result.text);
    assert(body.choices?.[0]?.message?.content?.includes('OK'), '非流式未返回真实回答');
    assert(body.usage?.total_tokens > 0, '非流式缺少真实 token 用量');
  }
  results.push({ endpoint: '/v1/chat/completions', model: 'workbuddy/hy3', stream, status: result.status, latencyMs: result.latencyMs, answer: 'OK' });
  console.log(JSON.stringify(results.at(-1)));
}
const responseResult = await request('/v1/responses', { model: 'workbuddy/hy3', input: '只回复 OK。', max_output_tokens: 256 });
const responseBody = JSON.parse(responseResult.text);
assert(responseBody.object === 'response' && JSON.stringify(responseBody.output).includes('OK'), 'Responses 转换调用失败');
results.push({ endpoint: '/v1/responses', model: 'workbuddy/hy3', status: responseResult.status, latencyMs: responseResult.latencyMs, answer: 'OK' });
console.log(JSON.stringify(results.at(-1)));

const toolsResult = await request('/v1/chat/completions', {
  model: 'workbuddy/hy3', max_tokens: 256,
  messages: [{ role: 'user', content: 'Call lookup with city Shanghai. Do not answer without this tool.' }],
  tools: [{ type: 'function', function: { name: 'lookup', description: 'Look up weather for a city.', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }],
  tool_choice: { type: 'function', function: { name: 'lookup' } },
});
const toolBody = JSON.parse(toolsResult.text);
const toolCall = toolBody.choices?.[0]?.message?.tool_calls?.[0];
assert(toolCall?.function?.name === 'lookup' && JSON.parse(toolCall.function.arguments).city === 'Shanghai', '工具调用名称 / 分片参数未正确返回');
assert(toolBody.choices[0].finish_reason === 'tool_calls', '工具调用没有正常结束');
console.log(JSON.stringify({ endpoint: '/v1/chat/completions', model: 'workbuddy/hy3', kind: 'tool_call', function: toolCall.function, status: toolsResult.status, latencyMs: toolsResult.latencyMs }));

// The four hy3 requests above exercise the shared gateway selector. Send enough
// small requests to cover a full pool cycle; verify actual account IDs separately
// in the installed app's per-account dispatch counters, not just from HTTP 200.
for (let index = 4; index < accounts.length; index++) {
  const probe = await request('/v1/chat/completions', { model: 'workbuddy/hy3', messages, max_tokens: 256 });
  const body = JSON.parse(probe.text);
  assert(body.choices?.[0]?.message?.content?.includes('OK'), '账号池轮询探测未返回真实回答');
  console.log(JSON.stringify({ kind: 'pool_cycle_probe', index: index + 1, status: probe.status, latencyMs: probe.latencyMs, answer: 'OK' }));
}

const paidModel = 'workbuddy/kimi-k3-1';
assert(models.includes(paidModel), '缺少预定的收费模型，停止扣费测试');
const paidResult = await request('/v1/chat/completions', { model: paidModel, messages, max_tokens: 512 });
const paid = JSON.parse(paidResult.text);
assert(paid.choices?.[0]?.message?.content?.includes('OK'), '收费模型未返回真实回答');
assert(paid.usage?.total_tokens > 0, '收费模型缺少 token 用量');
results.push({ endpoint: '/v1/chat/completions', model: paidModel, status: paidResult.status, latencyMs: paidResult.latencyMs, answer: 'OK', usage: paid.usage });
console.log(JSON.stringify(results.at(-1)));
let balancesAfter = await Promise.all(accounts.map(balance));
let creditsSpent = balancesBefore.reduce((sum, amount, index) => sum + amount - balancesAfter[index], 0);
// Billing is eventually consistent: a real charged call can appear in the
// official resource balance several minutes later. Never substitute usage.credit
// for an observed balance decrease, and never retry a paid call to force a pass.
const creditDeadline = Date.now() + creditWaitSeconds * 1000;
while (creditsSpent <= 0 && Date.now() < creditDeadline) {
  console.log(JSON.stringify({ phase: 'waiting_for_billing', elapsedLimitSeconds: creditWaitSeconds }));
  await new Promise((resolve) => setTimeout(resolve, Math.min(30000, creditDeadline - Date.now())));
  balancesAfter = await Promise.all(accounts.map(balance));
  creditsSpent = balancesBefore.reduce((sum, amount, index) => sum + amount - balancesAfter[index], 0);
}
const decreasedAccounts = balancesBefore.filter((amount, index) => balancesAfter[index] < amount).length;
console.log(JSON.stringify({ phase: 'credits', creditsSpent, decreasedAccounts, reportedCredit: paid.usage.credit ?? null, balancesBefore, balancesAfter }));
assert(creditsSpent > 0, '尚未观察到官方余额扣减，不能声明扣费验收通过');
console.log('LIVE_GATEWAY_PASS');
