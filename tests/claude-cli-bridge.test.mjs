// End-to-end test with fake credentials and a fake Claude executable only.
// It never contacts an upstream service or consumes a subscription quota.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, chmod, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const bundle = resolve('third_party/claude-cli-proxy/cle-claude-cli.bundle.cjs');
const sidecar = process.env.CLE_TEST_SIDECAR;
async function listen(server) {
  await new Promise((ok, fail) => server.once('error', fail).listen(0, '127.0.0.1', ok));
  return server.address().port;
}
async function freePort() {
  const socket = createServer(); const port = await listen(socket);
  await new Promise(ok => socket.close(ok)); return port;
}
async function waitReady(port, key, child, path = '/health') {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`helper exited (${child.exitCode})`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${key}` } });
      if (r.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error('helper startup timed out');
}
async function jsonRequest(port, key, body) {
  return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  });
}

test('isolates credentials, proxy settings and models; rejects unsupported input; forwards failures', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cle-claude-cli-test-'));
  const fakeCli = join(home, 'fake-claude'); const capture = join(home, 'capture.jsonl');
  await mkdir(join(home, '.claude'));
  await writeFile(join(home, '.claude/settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' } }));
  await writeFile(fakeCli, `#!${process.execPath}\n` + String.raw`
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('fake-claude 1.0'); process.exit(0); }
let prompt = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', x => prompt += x);
process.stdin.on('end', () => {
  const args = process.argv.slice(2), model = args[args.indexOf('--model')+1];
  fs.appendFileSync(process.env.FAKE_CAPTURE, JSON.stringify({args, token:process.env.CLAUDE_CODE_OAUTH_TOKEN,
    base:process.env.ANTHROPIC_BASE_URL, key:process.env.CLE_CREDENTIAL_KEY, secret:process.env.CLE_PROXY_AUTH_TOKEN,
    hasToolResult:prompt.includes('FAKE_TOOL_DATA')})+'\n');
  const error = prompt.includes('SIMULATE_ERROR');
  const output = prompt.includes('SIMULATE_TOOL') ? JSON.stringify({tool_call:{name:'exec',arguments:{command:'echo safe'}}}) : error ? 'quota exceeded' : 'MOCK_OK';
  console.log(JSON.stringify({type:'assistant',message:{model,id:'msg',type:'message',role:'assistant',content:[{type:'text',text:output}],stop_reason:'end_turn',usage:{input_tokens:1,output_tokens:1}},session_id:'fake',uuid:'fake'}));
  console.log(JSON.stringify({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:output}},session_id:'fake',uuid:'fake'}));
  console.log(JSON.stringify({type:'result',subtype:error?'error':'success',is_error:error,duration_ms:1,duration_api_ms:1,num_turns:1,result:output,session_id:'fake',total_cost_usd:0,usage:{input_tokens:1,output_tokens:1},modelUsage:{[model]:{inputTokens:1,outputTokens:1,costUSD:0}}}));
});
`);
  await chmod(fakeCli, 0o700);
  let bridgeCalls = 0; let denyBridge = false;
  const bridge = createServer((req, res) => {
    bridgeCalls++;
    if (denyBridge || !['/credentials/claude~fixture', '/credentials/claude~fixture2'].includes(req.url) || req.headers.authorization !== 'Bearer fake-bridge-key') {
      res.writeHead(401).end('{}'); return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ metadata: { access_token: req.url.endsWith('fixture2') ? 'fake-access-token-2' : 'fake-access-token' } }));
  });
  const bridgePort = await listen(bridge), port = await freePort(), proxyKey = 'fake-proxy-key';
  const env = { PATH: process.env.PATH, HOME: home, FAKE_CAPTURE: capture,
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', ANTHROPIC_AUTH_TOKEN: 'fake-vscode-token',
    CLE_CREDENTIAL_URL: `http://127.0.0.1:${bridgePort}/credentials/claude~fixture`,
    CLE_CREDENTIAL_KEY: 'fake-bridge-key', CLE_PROXY_AUTH_TOKEN: proxyKey, CLE_CLAUDE_CLI: fakeCli,
    CLAUDE_PROXY_RUNTIME: 'print', CLAUDE_PROXY_WARM_POOL: '0', CLAUDE_PROXY_TRACE_ENABLED: '0' };
  const proxy = spawn(process.execPath, [bundle, String(port)], { env, stdio: 'ignore' });
  let gateway; let proxy2;
  try {
    await waitReady(port, proxyKey, proxy);
    const request = { model: 'claude-cli/claude-haiku-5-5', messages: [{ role: 'user', content: 'hello' }] };
    assert.equal((await jsonRequest(port, null, request)).status, 401);
    assert.equal(bridgeCalls, 0, 'unauthorized requests must not fetch credentials');
    let r = await jsonRequest(port, proxyKey, request);
    assert.equal(r.status, 200); let body = await r.json();
    assert.equal(body.model, 'claude-haiku-5-5'); assert.equal(body.choices[0].message.content, 'MOCK_OK');
    const captures = (await readFile(capture, 'utf8')).trim().split('\n').map(JSON.parse);
    const entry = captures.at(-1);
    assert.equal(entry.token, 'fake-access-token'); assert.equal(entry.base, undefined);
    assert.equal(entry.key, undefined); assert.equal(entry.secret, undefined);
    assert.equal(entry.args[entry.args.indexOf('--model') + 1], 'claude-haiku-5-5');
    assert.equal(entry.args[entry.args.indexOf('--setting-sources') + 1], '');
    assert.equal(entry.args[entry.args.indexOf('--tools') + 1], '');
    assert.ok(entry.args.includes('--strict-mcp-config')); assert.ok(entry.args.includes('--safe-mode'));

    const callsBeforeImage = bridgeCalls;
    r = await jsonRequest(port, proxyKey, { ...request, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.invalid/x.png' } }] }] });
    assert.equal(r.status, 400); assert.equal(bridgeCalls, callsBeforeImage);
    r = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method:'POST', headers:{ authorization:`Bearer ${proxyKey}`, 'content-type':'application/json' },
      body:JSON.stringify({model:request.model, input:[{role:'user',content:[{type:'input_image',image_url:'https://example.invalid/x.png'}]}]}) });
    assert.equal(r.status, 400); assert.equal(bridgeCalls, callsBeforeImage);
    r = await jsonRequest(port, proxyKey, { ...request, messages: [{ role: 'user', content: 'SIMULATE_ERROR' }] });
    assert.equal(r.status, 429); assert.match((await r.json()).error.message, /quota/);
    r = await jsonRequest(port, proxyKey, { ...request, messages: [{ role: 'user', content: 'SIMULATE_TOOL' }], tools: [{ type:'function', function:{ name:'exec', parameters:{ type:'object' } } }], tool_choice:'auto' });
    assert.equal(r.status, 200); body = await r.json();
    assert.equal(body.choices[0].finish_reason, 'tool_calls'); assert.equal(body.choices[0].message.tool_calls[0].function.name, 'exec');
    r = await jsonRequest(port, proxyKey, { ...request, stream: true });
    assert.equal(r.status, 200); assert.match(await r.text(), /MOCK_OK/);
    denyBridge = true;
    r = await jsonRequest(port, proxyKey, request); assert.ok(r.status >= 400);
    denyBridge = false;

    if (sidecar) {
      const gatewayPort = await freePort(), authDir = join(home, 'auths'); await mkdir(authDir);
      const cfg = join(home, 'config.json'), manifest = join(home, 'manifest.json');
      const gatewayKey = 'fake-gateway-key';
      const modelNames = [
        'claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929', 'claude-sonnet-4-6',
        'claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-5-20251101', 'claude-opus-4-1-20250805',
        'claude-opus-4-20250514', 'claude-sonnet-4-20250514', 'claude-3-7-sonnet-20250219',
        'claude-3-5-haiku-20241022', 'claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5',
        'claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-fable-5', 'claude-opus-4-8',
        'claude-opus-4', 'claude-sonnet-4', 'claude-haiku-4', 'claude-future-model-6',
      ];
      const mappedModels = modelNames.map(name => ({name,alias:`claude-cli/${name}`}));
      const registeredModels = modelNames.map(name => `claude-cli/${name}`);
      const port2 = await freePort(), proxyKey2 = 'fake-proxy-key-2';
      proxy2 = spawn(process.execPath, [bundle, String(port2)], { env: { ...env,
        CLE_CREDENTIAL_URL:`http://127.0.0.1:${bridgePort}/credentials/claude~fixture2`, CLE_PROXY_AUTH_TOKEN:proxyKey2 }, stdio:'ignore' });
      await waitReady(port2, proxyKey2, proxy2);
      await writeFile(cfg, JSON.stringify({ host:'127.0.0.1', port:gatewayPort, 'auth-dir':authDir, 'api-keys':[gatewayKey],
        'openai-compatibility': [{ name:'claude-cli', 'base-url':`http://127.0.0.1:${port}/v1`,
          'api-key-entries':[{ 'api-key':proxyKey, 'proxy-url':'direct' }],
          models:mappedModels },
          { name:'claude-cli', 'base-url':`http://127.0.0.1:${port2}/v1`,
          'api-key-entries':[{ 'api-key':proxyKey2, 'proxy-url':'direct' }],
          models:mappedModels }] }));
      await writeFile(manifest, JSON.stringify({ enabled:true, listenHost:'127.0.0.1', listenPort:gatewayPort,
        apiKeys:[{id:'test',key:gatewayKey,enabled:true}], accounts:[{id:'fixture',authId:'fixture',provider:'claude-cli',upstreamApiKey:proxyKey,models:registeredModels},
          {id:'fixture2',authId:'fixture2',provider:'claude-cli',upstreamApiKey:proxyKey2,models:registeredModels}],
        modelIds:registeredModels, providers:['claude-cli'], routingStrategy:'round-robin', nativeModelRegistry:true }));
      gateway = spawn(sidecar, ['--config',cfg,'--manifest',manifest], { env: { PATH:process.env.PATH, HOME:home }, stdio:'ignore' });
      await waitReady(gatewayPort, gatewayKey, gateway, '/healthz');
      const beforeGateway = (await readFile(capture, 'utf8')).trim().split('\n').length;
      for (let i = 0; i < 6; i++) {
        r = await jsonRequest(gatewayPort, gatewayKey, request);
        assert.equal(r.status, 200, `gateway response ${r.status}: ${await r.clone().text()}`);
        body = await r.json(); assert.equal(body.choices[0].message.content, 'MOCK_OK');
      }
      const tokens = (await readFile(capture, 'utf8')).trim().split('\n').slice(beforeGateway).map(JSON.parse).map(row => row.token);
      assert.ok(tokens.includes('fake-access-token'), 'gateway must route to the first account too');
      assert.ok(tokens.includes('fake-access-token-2'), 'gateway must route to the second account too');
      for (const model of modelNames) {
        r = await jsonRequest(gatewayPort, gatewayKey, {...request, model:`claude-cli/${model}`});
        assert.equal(r.status, 200, `${model} gateway response ${r.status}: ${await r.clone().text()}`);
        await r.arrayBuffer();
        const latest = JSON.parse((await readFile(capture, 'utf8')).trim().split('\n').at(-1));
        assert.equal(latest.args[latest.args.indexOf('--model') + 1], model, `gateway changed ${model}`);
      }
      r = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, { method:'POST',
        headers:{ authorization:`Bearer ${gatewayKey}`, 'content-type':'application/json' },
        body:JSON.stringify({ model:request.model, input:'hello', stream:false }) });
      assert.equal(r.status, 200, `Responses API returned ${r.status}: ${await r.clone().text()}`);
      body = await r.json(); assert.match(JSON.stringify(body.output), /MOCK_OK/);
      r = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, { method:'POST',
        headers:{ authorization:`Bearer ${gatewayKey}`, 'content-type':'application/json' },
        body:JSON.stringify({ model:request.model, input:'SIMULATE_TOOL', stream:false,
          tools:[{type:'function',name:'exec',parameters:{type:'object',properties:{command:{type:'string'}}}}], tool_choice:'auto' }) });
      assert.equal(r.status, 200, `Responses tool API returned ${r.status}: ${await r.clone().text()}`);
      body = await r.json(); assert.ok(body.output.some(item => item.type === 'function_call' && item.name === 'exec'));
      r = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, { method:'POST',
        headers:{ authorization:`Bearer ${gatewayKey}`, 'content-type':'application/json' },
        body:JSON.stringify({ model:request.model, stream:false, input:[
          {type:'message',role:'user',content:[{type:'input_text',text:'Use the tool'}]},
          {type:'function_call',name:'exec',call_id:'call_fixture',arguments:'{"command":"echo safe"}'},
          {type:'function_call_output',call_id:'call_fixture',output:'FAKE_TOOL_DATA'}] }) });
      assert.equal(r.status, 200, `Responses tool result returned ${r.status}: ${await r.clone().text()}`);
      body = await r.json(); assert.match(JSON.stringify(body.output), /MOCK_OK/);
      const latestToolResult = JSON.parse((await readFile(capture, 'utf8')).trim().split('\n').at(-1));
      assert.equal(latestToolResult.hasToolResult, true, 'tool output must reach Claude');
      r = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, { method:'POST',
        headers:{ authorization:`Bearer ${gatewayKey}`, 'content-type':'application/json' },
        body:JSON.stringify({ model:request.model, input:'hello', stream:true }) });
      assert.equal(r.status, 200); assert.match(await r.text(), /MOCK_OK/);
      const callsBeforeGatewayImage = bridgeCalls;
      r = await jsonRequest(gatewayPort, gatewayKey, { ...request, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.invalid/x.png' } }] }] });
      assert.ok(r.status >= 400, `gateway must not silently discard the image: ${r.status}`);
      assert.equal(bridgeCalls, callsBeforeGatewayImage);
    }
  } finally {
    gateway?.kill(); proxy2?.kill(); proxy.kill(); await new Promise(ok => bridge.close(ok));
    await rm(home, { recursive:true, force:true });
  }
});
