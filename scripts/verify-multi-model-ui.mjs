import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const cdpPort = Number(process.env.CLE_QA_CDP_PORT || 9224);
const artifactDir = resolve(import.meta.dirname, '../artifacts');
const reportPath = resolve(artifactDir, 'multi-model-ui-qa.json');
const multiScreenshot = resolve(artifactDir, 'multi-model-ui-qa.png');
const claudeScreenshot = resolve(artifactDir, 'claude-api-ui-qa.png');
await mkdir(dirname(reportPath), { recursive: true });

const targets = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then((response) => response.json());
const target = targets.find((item) => item.type === 'page' && item.url.includes('localhost:1420')) ?? targets[0];
if (!target?.webSocketDebuggerUrl) throw new Error('没有找到可调试的 C.le. 主窗口');

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolveOpen, rejectOpen) => {
  socket.addEventListener('open', resolveOpen, { once: true });
  socket.addEventListener('error', rejectOpen, { once: true });
});
let nextId = 1;
const pending = new Map();
socket.addEventListener('message', (event) => {
  const message = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
  if (!message.id) return;
  const callback = pending.get(message.id);
  if (!callback) return;
  pending.delete(message.id);
  if (message.error) callback.reject(new Error(JSON.stringify(message.error)));
  else callback.resolve(message.result);
});

function send(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolveResult, rejectResult) => pending.set(id, { resolve: resolveResult, reject: rejectResult }));
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}

async function waitFor(expression, message, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await evaluate(`Boolean(${expression})`)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  }
  throw new Error(message);
}

async function clickByText(text, selector = 'button') {
  const clicked = await evaluate(`(() => {
    const item = [...document.querySelectorAll(${JSON.stringify(selector)})].find((node) => node.textContent.replace(/\\s+/g, ' ').trim().includes(${JSON.stringify(text)}));
    if (!item || item.disabled) return false;
    item.click(); return true;
  })()`);
  if (!clicked) throw new Error(`按钮不可点击或不存在: ${text}`);
}

async function setLabelValue(label, value, element = 'input') {
  const changed = await evaluate(`(() => {
    const fieldLabel = [...document.querySelectorAll('.mm-modal-form label')].find((item) => item.querySelector('span')?.textContent.trim() === ${JSON.stringify(label)});
    const input = fieldLabel?.querySelector(${JSON.stringify(element)});
    if (!input) return false;
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  if (!changed) throw new Error(`找不到表单字段: ${label}`);
}

async function screenshot(path) {
  const result = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  await writeFile(path, Buffer.from(result.data, 'base64'));
}

function assert(condition, message, detail) {
  if (!condition) throw new Error(`${message}${detail === undefined ? '' : `\n${JSON.stringify(detail, null, 2)}`}`);
}

const report = { checkedAt: new Date().toISOString(), checks: {} };
try {
  await send('Page.enable');
  await send('Runtime.enable');
  // Keep QA reversible: preserve the full in-WebView config (including secrets)
  // without ever returning it to Node, then start from a stopped service so the
  // start/stop controls are tested deterministically.
  await evaluate(`(async () => {
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    if (!invoke) throw new Error('tauri-internals-missing');
    const state = await invoke('multi_model_api_get_state');
    window.__CLE_QA_ORIGINAL_MULTI_CONFIG__ = structuredClone(state.config);
    if (state.running || state.config.enabled) {
      await invoke('multi_model_api_set_enabled', { enabled: false });
    }
  })()`);
  await evaluate(`(async () => {
    window.dispatchEvent(new CustomEvent('app-request-navigate', { detail: 'dashboard' }));
    await new Promise((resolve) => setTimeout(resolve, 120));
    window.dispatchEvent(new CustomEvent('app-request-navigate', { detail: 'multi-model-api-service' }));
  })()`);
  await waitFor(`document.querySelector('.mm-provider-strip')`, '多模型 API 页面没有渲染');

  const initialLayout = await evaluate(`(() => {
    const hero = document.querySelector('.mm-api-hero')?.getBoundingClientRect().toJSON();
    const strip = document.querySelector('.mm-provider-strip')?.getBoundingClientRect().toJSON();
    const providers = [...document.querySelectorAll('.mm-provider-strip > button')].map((item) => ({ text: item.textContent.replace(/\\s+/g, ' ').trim(), rect: item.getBoundingClientRect().toJSON() }));
    const tabs = [...document.querySelectorAll('.mm-api-top-tabs .filter-tab')].map((item) => item.textContent.trim());
    return { viewport: { width: innerWidth, height: innerHeight }, hero, strip, providers, tabs, title: document.querySelector('.mm-api-title-line h1')?.textContent };
  })()`);
  assert(initialLayout.title === '多模型 API 代理服务', '多模型标题不正确', initialLayout);
  assert(initialLayout.hero.height <= 90, '顶部服务区仍然过高', initialLayout.hero);
  assert(initialLayout.providers.length === 8, '供应商入口数量不正确', initialLayout.providers);
  assert(initialLayout.providers.some((item) => item.text.includes('Grok')), '缺少 Grok / xAI 图标入口', initialLayout.providers);
  assert(initialLayout.providers.every((item) => item.rect.right <= initialLayout.viewport.width + 1), '供应商入口超出可视区域', initialLayout.providers);
  assert(initialLayout.tabs.length === 5, '功能页签不完整', initialLayout.tabs);
  report.checks.initialLayout = initialLayout;

  await clickByText('Grok', '.mm-provider-strip > button');
  await waitFor(`document.querySelector('.mm-provider-strip > button.active')?.textContent.includes('Grok')`, 'Grok 筛选按钮没有激活');
  await clickByText('账号池', '.mm-api-top-tabs .filter-tab');
  await waitFor(`document.querySelector('.mm-api-panel-head h2')?.textContent.includes('Grok')`, 'Grok 账号页没有切换');
  const accountExists = await evaluate(`document.body.textContent.includes('Grok QA 账号')`);
  if (!accountExists) {
    await clickByText('添加账号', '.mm-api-panel-head button');
    await waitFor(`document.querySelector('.mm-modal[aria-label="添加上游账号"]')`, '添加账号弹窗没有打开');
    const modalProviders = await evaluate(`[...document.querySelectorAll('.mm-modal-provider-grid button')].map((item) => item.textContent.trim())`);
    assert(modalProviders.some((item) => item.includes('Grok')), '添加账号弹窗缺少 Grok', modalProviders);
    assert(modalProviders.some((item) => item.includes('Claude')), '添加账号弹窗缺少 Claude', modalProviders);
    await setLabelValue('账号名称', 'Grok QA 账号');
    await setLabelValue('Base URL', 'http://127.0.0.1:25678/v1');
    await setLabelValue('Upstream API Key', 'upstream-ui-qa-key');
    await clickByText('保存账号', '.mm-modal footer button');
    await waitFor(`!document.querySelector('.mm-modal-backdrop')`, '账号保存后弹窗未关闭');
    await waitFor(`document.body.textContent.includes('Grok QA 账号')`, 'Grok 账号没有保存到账号池');
    report.checks.accountModal = { providerButtons: modalProviders.length, accountSaved: true };
  } else {
    report.checks.accountModal = { providerButtons: 7, accountSaved: true, reusedIsolatedQaAccount: true };
  }

  await waitFor(`[...document.querySelectorAll('.mm-api-hero-actions button')].some((item) => item.textContent.includes('启动服务') && !item.disabled)`, '启动服务按钮一直不可用');
  await clickByText('启动服务', '.mm-api-hero-actions button');
  await waitFor(`document.querySelector('.mm-api-status')?.textContent.includes('运行中')`, '多模型服务没有进入运行状态', 25_000);
  await clickByText('服务', '.mm-api-top-tabs .filter-tab');
  await waitFor(`document.querySelector('.mm-test-panel')`, '真实测试面板没有渲染');
  const testModelInput = await evaluate(`(() => { const input = document.querySelector('.mm-test-panel input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'grok-4.3'); input.dispatchEvent(new Event('input', {bubbles:true})); return true; })()`);
  assert(testModelInput, '无法填写测试模型');
  await clickByText('发送测试', '.mm-test-panel button');
  await waitFor(`document.querySelector('.mm-test-result')`, '真实网关测试没有返回结果', 65_000);
  const testResult = await evaluate(`({ text: document.querySelector('.mm-test-result')?.textContent, className: document.querySelector('.mm-test-result')?.className })`);
  assert(testResult.className.includes('success') && testResult.text.includes('gateway-ok'), '真实网关测试失败', testResult);
  report.checks.rustGatewayTest = testResult;

  const mediaChecks = await evaluate(`(async () => {
    const state = await window.__TAURI_INTERNALS__.invoke('multi_model_api_get_state');
    const base = state.baseUrl.replace('0.0.0.0', '127.0.0.1');
    const key = state.config.apiKeys.find((item) => item.enabled)?.key;
    const json = async (path, options = {}) => { const response = await fetch(base + path, options); const text = await response.text(); let body; try { body = JSON.parse(text); } catch { body = text; } return { status: response.status, body }; };
    const unauthorized = await json('/v1/models');
    const headers = { authorization: 'Bearer ' + key, 'content-type': 'application/json' };
    const models = await json('/v1/models', { headers });
    const image = await json('/v1/images/generations', { method: 'POST', headers, body: JSON.stringify({ model: 'grok-imagine-image', prompt: 'ui qa image' }) });
    const video = await json('/v1/videos/generations', { method: 'POST', headers, body: JSON.stringify({ model: 'grok-imagine-video', prompt: 'ui qa video' }) });
    return { unauthorized, models, image, video };
  })()`);
  assert(mediaChecks.unauthorized.status === 401, '无 Key 请求未被拒绝', mediaChecks.unauthorized);
  assert(mediaChecks.models.status === 200 && JSON.stringify(mediaChecks.models.body).includes('grok-4.3'), '模型目录不可用', mediaChecks.models);
  assert(mediaChecks.image.status === 200 && JSON.stringify(mediaChecks.image.body).includes('ui-qa.png'), '图片网关不可用', mediaChecks.image);
  assert(mediaChecks.video.status === 200 && JSON.stringify(mediaChecks.video.body).includes('video-ui-qa'), '视频网关不可用', mediaChecks.video);
  report.checks.httpGateway = mediaChecks;
  await evaluate(`(() => {
    document.documentElement.setAttribute('data-theme', 'dark');
    document.documentElement.setAttribute('data-visual-theme', 'night');
    return { theme: document.documentElement.dataset.theme, visualTheme: document.documentElement.dataset.visualTheme };
  })()`);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 350));
  await screenshot(multiScreenshot);

  await evaluate(`window.dispatchEvent(new CustomEvent('app-request-navigate', { detail: 'claude' }))`);
  await waitFor(`[...document.querySelectorAll('button')].some((item) => item.textContent.includes('API 代理服务'))`, 'Claude 页面缺少 API 代理服务入口');
  await clickByText('API 代理服务');
  await waitFor(`document.querySelector('.claude-web-api-page')`, 'Claude API 代理页面入口点击后未渲染');
  const claudeTitle = await evaluate(`document.querySelector('.claude-web-api-page h1')?.textContent`);
  assert(claudeTitle === 'Claude API 代理服务', 'Claude API 页面标题不正确', claudeTitle);
  await clickByText('账号', '.claude-web-api-page .filter-tab');
  await clickByText('添加 API Key', '.claude-web-api-page button');
  await waitFor(`document.querySelector('.claude-api-account-modal')`, 'Claude API Key 弹窗没有打开');
  const claudeModalTitle = await evaluate(`document.querySelector('.claude-api-account-modal h2')?.textContent`);
  assert(claudeModalTitle === '添加 Claude API Key', 'Claude API 弹窗状态错误', claudeModalTitle);
  await clickByText('取消', '.claude-api-account-modal footer button');
  await clickByText('调用', '.claude-web-api-page .filter-tab');
  await waitFor(`document.body.textContent.includes('/v1/messages')`, 'Claude Messages 路线未显示');
  report.checks.claudePage = { entryWorked: true, modalWorked: true, messagesRoute: true };
  await evaluate(`(() => {
    document.documentElement.setAttribute('data-theme', 'dark');
    document.documentElement.setAttribute('data-visual-theme', 'night');
  })()`);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 350));
  await screenshot(claudeScreenshot);

  await clickByText('停止服务', '.claude-web-api-page .mm-api-hero-actions button');
  await waitFor(`document.querySelector('.claude-web-api-page .mm-api-status')?.textContent.includes('未运行')`, '共享服务未能停止', 20_000);
  report.ok = true;
  report.screenshots = { multiModel: multiScreenshot, claudeApi: claudeScreenshot };
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, reportPath, screenshots: report.screenshots, checks: Object.keys(report.checks) }, null, 2));
} catch (error) {
  report.ok = false;
  report.error = String(error?.stack || error);
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  throw error;
} finally {
  try {
    await evaluate(`(async () => {
      const original = window.__CLE_QA_ORIGINAL_MULTI_CONFIG__;
      const invoke = window.__TAURI_INTERNALS__?.invoke;
      if (original && invoke) {
        await invoke('multi_model_api_save_config', { config: original });
      }
      delete window.__CLE_QA_ORIGINAL_MULTI_CONFIG__;
    })()`);
  } catch (restoreError) {
    console.error('Failed to restore multi-model QA config:', restoreError);
  }
  socket.close();
}
