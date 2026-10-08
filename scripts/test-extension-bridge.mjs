// Empty, temporary account store: exercises management/sign-in without any paid inference.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
const folder = mkdtempSync(resolve(tmpdir(), 'cle-extension-fixture-'));
const listener = createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const key = 'fixture-private-capability-not-a-live-account';
const target = process.platform === 'darwin' ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin` : 'x86_64-pc-windows-msvc';
const binary = resolve(root, `sidecars/agent2api/bin/cle-agent-bridge-${target}${process.platform === 'win32' ? '.exe' : ''}`);
const child = spawn(binary, [], { env: { ...process.env, AGENT2API_PROXY_HOME: folder, AGENT2API_HOST: '127.0.0.1', AGENT2API_PROXY_PORT: String(port), AGENT2API_PROXY_API_KEY: key, AGENT2API_ADMIN_PASSWORD: '', AGENT2API_ALLOW_NO_KEY: '' }, stdio: 'ignore' });
let calls = 0;
async function request(method, path, body, authorized = true) {
  assert(!path.startsWith('/v1/'), 'test must never send inference');
  calls++;
  return fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { ...(authorized ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(1500) });
}
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (child.exitCode != null) throw new Error('sidecar exited before readiness');
    try { if ((await request('GET', '/api/accounts')).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, 'sidecar startup');
  const accounts = await (await request('GET', '/api/accounts')).json();
  assert.deepEqual(accounts.data.accounts, []);
  assert(!(await request('GET', '/api/accounts', null, false)).ok, 'management requires private key');
  const center = await (await request('GET', '/api/checkin-center')).json();
  assert.equal(center.data.auto.enabled, false);
  assert.deepEqual(center.data.auto.providerOptions.map(item => item.id), ['raccoon', 'autoclaw', 'autoclaw-intl', 'qoder', 'trae', 'loomy']);
  assert(!center.data.auto.providerOptions.some(item => item.id.includes('workbuddy') || ['catpaw', 'accio', 'kuku'].includes(item.id)));
  assert(!(await request('POST', '/api/auto-checkin', { time: '99:99' })).ok);
  assert((await request('POST', '/api/auto-checkin', { enabled: false, time: '08:30', providers: ['raccoon', 'trae'] })).ok);
  const saved = await (await request('GET', '/api/auto-checkin')).json();
  assert.equal(saved.data.time, '08:30'); assert.deepEqual(saved.data.providers, ['raccoon', 'trae']);
  const run = await (await request('POST', '/api/auto-checkin/run')).json();
  assert.equal(run.success, true); assert.equal(run.data.total, 0); assert.equal(run.data.failedCount, 0);
  const keyList = await (await request('POST', '/api/keys', { name: 'C.le pool: trae', allowedProviders: ['trae'] })).json();
  assert.equal(keyList.success, true); assert.deepEqual(keyList.data.created.allowedProviders, ['trae']);
  assert(!(await request('POST', '/api/session/login/start', { provider: 'not-a-provider' })).ok);
  console.log(`Extension bridge: startup, auth, account list, safe sign-in providers, validation, save/run, scoped key OK (${calls} local management calls; 0 inference).`);
} finally {
  child.kill('SIGTERM');
  if (child.exitCode == null) await new Promise(resolve => child.once('exit', resolve));
  rmSync(folder, { recursive: true, force: true });
}
