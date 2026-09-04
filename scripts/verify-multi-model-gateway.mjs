import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const sidecar = resolve(root, 'sidecars/cle-cliproxy/bin/cle-cliproxy-x86_64-pc-windows-msvc.exe');
const reportPath = resolve(root, 'artifacts/multi-model-gateway-e2e.json');
const tempRoot = await mkdtemp(join(tmpdir(), 'cle-multi-model-e2e-'));
const authDir = join(tempRoot, 'auths');
await mkdir(authDir, { recursive: true });

const requests = [];
const fakeUpstream = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');
  requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization ?? '', body });
  response.setHeader('content-type', 'application/json');
  if (request.url?.includes('/chat/completions')) {
    response.end(JSON.stringify({
      id: 'chatcmpl-e2e', object: 'chat.completion', created: 1, model: 'grok-4.3',
      choices: [{ index: 0, message: { role: 'assistant', content: 'gateway-ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }));
    return;
  }
  if (request.url?.includes('/images/generations')) {
    response.end(JSON.stringify({ created: 1, data: [{ url: 'https://sandbox.invalid/e2e.png' }] }));
    return;
  }
  if (request.url?.includes('/videos/generations')) {
    response.end(JSON.stringify({ request_id: 'video-e2e', status: 'queued' }));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: { message: `unexpected fake upstream route: ${request.url}` } }));
});

function listen(server) {
  return new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => accept(server.address().port));
  });
}

async function requestJson(url, init = {}) {
  const started = performance.now();
  const response = await fetch(url, init);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body, latencyMs: Math.round(performance.now() - started) };
}

function assert(condition, message, detail) {
  if (!condition) throw new Error(`${message}${detail === undefined ? '' : `\n${JSON.stringify(detail, null, 2)}`}`);
}

let child;
let report;
let stderr = '';
const sidecarEvents = [];
try {
  const upstreamPort = await listen(fakeUpstream);
  const portProbe = createServer();
  const gatewayPort = await listen(portProbe);
  await new Promise((resolveClose) => portProbe.close(resolveClose));

  const configPath = join(tempRoot, 'config.json');
  const manifestPath = join(tempRoot, 'manifest.json');
  await writeFile(configPath, JSON.stringify({
    host: '127.0.0.1', port: gatewayPort, 'auth-dir': authDir,
    'api-keys': ['downstream-e2e-key'], 'request-retry': 0,
    debug: false, 'request-log': false, 'passthrough-headers': true,
    'disable-image-generation': false,
    routing: { strategy: 'round-robin', 'session-affinity': false, 'session-affinity-ttl': '1h' },
    'openai-compatibility': [{
      name: 'xai', 'base-url': `http://127.0.0.1:${upstreamPort}/v1`,
      'api-key-entries': [
        { 'api-key': 'upstream-e2e-key-a' },
        { 'api-key': 'upstream-e2e-key-b' },
        { 'api-key': 'upstream-e2e-key-exhausted' },
      ],
      models: [
        { name: 'grok-4.3', alias: '' },
        { name: 'grok-imagine-image', alias: '', image: true },
        { name: 'grok-imagine-video', alias: '' },
      ],
    }],
  }, null, 2));
  await writeFile(manifestPath, JSON.stringify({
    apiKeys: [{ id: 'key-e2e', label: 'E2E Key', key: 'downstream-e2e-key', allowedModels: [], excludedModels: [], enabled: true }],
    accounts: [
      { id: 'xai-e2e-a', email: 'xai-a@sandbox.invalid', upstreamApiKey: 'upstream-e2e-key-a', provider: 'xai', models: ['grok-4.3', 'grok-imagine-image', 'grok-imagine-video'], modelQuotas: { 'grok-4.3': 82 } },
      { id: 'xai-e2e-b', email: 'xai-b@sandbox.invalid', upstreamApiKey: 'upstream-e2e-key-b', provider: 'xai', models: ['grok-4.3', 'grok-imagine-image', 'grok-imagine-video'], modelQuotas: { 'grok-4.3': 17 } },
      { id: 'xai-e2e-exhausted', email: 'xai-exhausted@sandbox.invalid', upstreamApiKey: 'upstream-e2e-key-exhausted', provider: 'xai', models: ['grok-4.3'], modelQuotas: { 'grok-4.3': 0 } },
    ],
    modelIds: ['grok-4.3', 'grok-imagine-image', 'grok-imagine-video'],
    modelAliases: [], excludedModels: [], routingStrategy: 'round-robin', providers: ['xai'],
    nativeModelRegistry: true, debugLogs: false,
  }, null, 2));

  child = spawn(sidecar, ['--config', configPath, '--manifest', manifestPath, '--parent-pid', String(process.pid)], {
    cwd: tempRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  await Promise.race([
    new Promise((resolveReady, rejectReady) => {
      let pending = '';
      child.stdout.on('data', (chunk) => {
        pending += chunk.toString();
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? '';
        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            sidecarEvents.push(event);
            if (event.type === 'ready') resolveReady();
          } catch { /* regular sidecar log */ }
        }
      });
      child.once('exit', (code) => rejectReady(new Error(`sidecar exited before ready: ${code}\n${stderr}`)));
    }),
    new Promise((_, rejectTimeout) => setTimeout(() => rejectTimeout(new Error(`sidecar ready timeout\n${stderr}`)), 15_000)),
  ]);
  // The auth-directory watcher completes just after the HTTP ready event on Windows.
  // Wait for model registration instead of racing the first real request against it.
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));

  const baseUrl = `http://127.0.0.1:${gatewayPort}`;
  const unauthorized = await requestJson(`${baseUrl}/v1/models`);
  const headers = { authorization: 'Bearer downstream-e2e-key', 'content-type': 'application/json' };
  const models = await requestJson(`${baseUrl}/v1/models`, { headers });
  const chat = await requestJson(`${baseUrl}/v1/chat/completions`, {
    method: 'POST', headers, body: JSON.stringify({ model: 'grok-4.3', messages: [{ role: 'user', content: 'Reply gateway-ok' }], stream: false }),
  });
  const balancingChats = [];
  for (let index = 0; index < 3; index += 1) {
    balancingChats.push(await requestJson(`${baseUrl}/v1/chat/completions`, {
      method: 'POST', headers, body: JSON.stringify({ model: 'grok-4.3', messages: [{ role: 'user', content: `Round robin probe ${index + 2}` }], stream: false }),
    }));
  }
  const image = await requestJson(`${baseUrl}/v1/images/generations`, {
    method: 'POST', headers, body: JSON.stringify({ model: 'grok-imagine-image', prompt: 'e2e image' }),
  });
  const video = await requestJson(`${baseUrl}/v1/videos/generations`, {
    method: 'POST', headers, body: JSON.stringify({ model: 'grok-imagine-video', prompt: 'e2e video' }),
  });

  assert(unauthorized.status === 401, '下游 Key 鉴权未拦截未授权请求', unauthorized);
  assert(models.status === 200, '模型目录请求失败', models);
  assert(JSON.stringify(models.body).includes('grok-4.3'), '模型目录缺少测试模型', models);
  assert(chat.status === 200 && JSON.stringify(chat.body).includes('gateway-ok'), '文本代理链路失败', chat);
  assert(balancingChats.every((item) => item.status === 200), '轮询测试请求失败', balancingChats);
  assert(image.status === 200 && JSON.stringify(image.body).includes('e2e.png'), '图片代理链路失败', image);
  assert(video.status === 200 && JSON.stringify(video.body).includes('video-e2e'), '视频代理链路失败', video);
  assert(requests.some((item) => item.url?.includes('/chat/completions')), '文本请求没有到达上游', requests);
  assert(requests.some((item) => item.url?.includes('/images/generations')), '图片请求没有到达上游', requests);
  assert(requests.some((item) => item.url?.includes('/videos/generations')), '视频请求没有到达上游', requests);
  const chatAuthorizations = requests
    .filter((item) => item.url?.includes('/chat/completions'))
    .map((item) => item.authorization);
  assert(JSON.stringify(chatAuthorizations) === JSON.stringify([
    'Bearer upstream-e2e-key-a',
    'Bearer upstream-e2e-key-b',
    'Bearer upstream-e2e-key-a',
    'Bearer upstream-e2e-key-b',
  ]), 'Round Robin 没有在正额度账号间严格轮询，或错误调用了明确耗尽账号', chatAuthorizations);

  report = { ok: true, checkedAt: new Date().toISOString(), baseUrl, upstreamPort, gatewayPort, unauthorized, models, chat, balancingChats, image, video, chatAuthorizations, upstreamRequests: requests, sidecarEvents };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, reportPath, checks: { unauthorized: unauthorized.status, models: models.status, chat: chat.status, roundRobin: chatAuthorizations, image: image.status, video: video.status }, upstreamRoutes: requests.map((item) => item.url) }, null, 2));
} catch (error) {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify({ ok: false, checkedAt: new Date().toISOString(), error: String(error), stderr, sidecarEvents, upstreamRequests: requests }, null, 2));
  console.error(`Sidecar events:\n${JSON.stringify(sidecarEvents, null, 2)}\nSidecar stderr:\n${stderr}`);
  throw error;
} finally {
  if (child && child.exitCode === null) {
    child.kill();
    await Promise.race([once(child, 'exit'), new Promise((resolveTimeout) => setTimeout(resolveTimeout, 3_000))]);
  }
  await new Promise((resolveClose) => fakeUpstream.close(resolveClose));
  await rm(tempRoot, { recursive: true, force: true });
}
