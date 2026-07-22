import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const python = 'C:\\Users\\34786\\AppData\\Local\\hermes\\hermes-agent\\venv\\Scripts\\python.exe';
const workdir = 'F:\\tmp_chat2api';
const env = { ...process.env };
const envPath = 'F:\\自动注册\\chat2api\\.env';
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) env[match[1]] = match[2];
}
if (process.env.CHAT2API_PROBE_PROXY) env.PROXY_URL = process.env.CHAT2API_PROBE_PROXY;

const child = spawn(python, ['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', '25005'], {
  cwd: workdir,
  env,
  windowsHide: true,
});
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    if (child.exitCode !== null) throw new Error(`Chat2API debug server exited with ${child.exitCode}`);
    try {
      const response = await fetch('http://127.0.0.1:25005/tokens');
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Chat2API debug server did not become ready');
}

let failure = null;
try {
  await waitForServer();
  process.env.CHAT2API_BASE_URL = 'http://127.0.0.1:25005';
  await import('./probe-chat2api.mjs');
  await new Promise((resolve) => setTimeout(resolve, 500));
} catch (error) {
  failure = error.message;
} finally {
  child.kill();
}

const redacted = stderr
  .split(/\r?\n/)
  .filter((line) => !line.includes('Request token:') && !line.includes('AUTHORIZATION:'))
  .map((line) => line
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@'))
  .slice(-60);
console.log(JSON.stringify({ failure, exitCode: child.exitCode, diagnostics: redacted }, null, 2));
if (failure) process.exitCode = 1;
