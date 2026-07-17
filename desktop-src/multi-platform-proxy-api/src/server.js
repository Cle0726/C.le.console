import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, saveConfig, PROJECT_ROOT } from './config.js';
import { RuntimeStateStore } from './runtime.js';
import { GatewayRouter } from './router.js';

let config = loadConfig();
const stateStore = new RuntimeStateStore();
let gateway = new GatewayRouter(config, stateStore);
const MAX_JSON_BODY_BYTES = 1024 * 1024;

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') return sendFile(res, path.join(PROJECT_ROOT, 'public', 'index.html'), 'text/html; charset=utf-8');
    if (req.method === 'GET' && req.url === '/ui.css') return sendFile(res, path.join(PROJECT_ROOT, 'public', 'ui.css'), 'text/css; charset=utf-8');
    if (req.method === 'GET' && req.url === '/ui.js') return sendFile(res, path.join(PROJECT_ROOT, 'public', 'ui.js'), 'application/javascript; charset=utf-8');
    if (req.method === 'GET' && req.url === '/healthz') return json(res, 200, healthPayload());
    if (req.method === 'GET' && req.url === '/v1/models') return json(res, 200, gateway.listModels());
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      if (!checkLocalApiKey(req)) return json(res, 401, { error: { message: 'missing or invalid local API key' } });
      const body = await readJson(req);
      const response = await gateway.chatCompletions(body);
      return json(res, 200, response);
    }
    if (req.method === 'POST' && req.url === '/v1/images/generations') {
      if (!checkLocalApiKey(req)) return json(res, 401, { error: { message: 'missing or invalid local API key' } });
      const body = await readJson(req);
      const response = await gateway.imageGenerations(body);
      return json(res, 200, response);
    }
    if (req.method === 'POST' && req.url === '/v1/responses') {
      if (!checkLocalApiKey(req)) return json(res, 401, { error: { message: 'missing or invalid local API key' } });
      const body = await readJson(req);
      const response = await gateway.responses(body);
      return json(res, 200, response);
    }
    if (req.method === 'GET' && req.url === '/admin/snapshot') {
      if (!checkAdmin(req)) return json(res, 401, { error: 'missing or invalid admin token' });
      return json(res, 200, snapshot());
    }
    if (req.method === 'POST' && req.url === '/admin/config') {
      if (!checkAdmin(req)) return json(res, 401, { error: 'missing or invalid admin token' });
      config = saveConfig(await readJson(req));
      gateway = new GatewayRouter(config, stateStore);
      return json(res, 200, snapshot());
    }
    if (req.method === 'POST' && req.url === '/admin/reload') {
      if (!checkAdmin(req)) return json(res, 401, { error: 'missing or invalid admin token' });
      config = loadConfig();
      gateway = new GatewayRouter(config, stateStore);
      return json(res, 200, snapshot());
    }
    if (req.method === 'POST' && req.url === '/admin/runtime/reset') {
      if (!checkAdmin(req)) return json(res, 401, { error: 'missing or invalid admin token' });
      stateStore.reset();
      return json(res, 200, snapshot());
    }
    return json(res, 404, { error: 'not found' });
  } catch (error) {
    return json(res, error.status || 500, {
      error: {
        message: error instanceof Error ? error.message : String(error),
        failures: error.failures || undefined,
      },
    });
  }
});

server.listen(config.listenPort, config.listenHost, () => {
  console.log(`Multi Platform CLI Proxy API listening on http://${config.listenHost}:${config.listenPort}`);
  console.log(`UI: http://${config.listenHost}:${config.listenPort}/`);
});

function healthPayload() {
  return {
    ok: true,
    service: 'multi-platform-proxy-api',
    listenHost: config.listenHost,
    listenPort: config.listenPort,
    models: config.models.length,
    providers: config.providers.length,
    accounts: config.accounts.length,
    runtimeStates: stateStore.list().length,
    updatedAt: new Date().toISOString(),
  };
}

function snapshot() {
  return { health: healthPayload(), config, runtimeStates: stateStore.list() };
}

function checkAdmin(req) {
  const token = bearerToken(req) || req.headers['x-admin-token'];
  return token === config.adminToken;
}

function checkLocalApiKey(req) {
  if (!config.requireApiKey) return true;
  const token = bearerToken(req);
  return Boolean(token && config.localApiKeys.includes(token));
}

function bearerToken(req) {
  const auth = req.headers.authorization || '';
  return auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
}

async function readJson(req) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_JSON_BODY_BYTES) {
      const error = new Error('request body exceeds 1 MiB limit');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function json(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function sendFile(res, filePath, contentType) {
  if (!fs.existsSync(filePath)) return json(res, 404, { error: 'file not found' });
  res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(fs.readFileSync(filePath));
}
