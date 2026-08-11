import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const endpoint = process.env.CLE_CDP_ENDPOINT ?? 'http://127.0.0.1:9337/json';
const baseUrl = process.env.CLE_UI_BASE_URL ?? 'http://127.0.0.1:1437';
const outputDir = process.env.CLE_TEXT_AUDIT_DIR
  ?? path.resolve('artifacts', 'text-overflow-audit');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect() {
  const targets = await (await fetch(endpoint)).json();
  const target = [...targets].reverse().find((item) => item.type === 'page') ?? targets[0];
  if (!target?.webSocketDebuggerUrl) throw new Error('No debuggable page found.');

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let sequence = 0;
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const operation = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) operation.reject(new Error(`${operation.method}: ${message.error.message}`));
    else operation.resolve(message.result);
  };
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject, method });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return { socket, send };
}

async function evaluate(send, expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result?.value;
}

async function waitFor(send, expression, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(send, expression)) return;
    await sleep(120);
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

const auditExpression = `(() => {
  const isVisible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 2 && rect.height > 2
      && style.display !== 'none'
      && style.visibility !== 'hidden'
      && Number(style.opacity) > .04;
  };
  const directText = (element) => [...element.childNodes]
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent ?? '')
    .join(' ')
    .trim()
    .replace(/\\s+/g, ' ');
  const describe = (element, reason) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      reason,
      tag: element.tagName.toLowerCase(),
      className: typeof element.className === 'string' ? element.className.slice(0, 180) : '',
      text: (element.textContent ?? '').trim().replace(/\\s+/g, ' ').slice(0, 140),
      client: [Math.round(element.clientWidth), Math.round(element.clientHeight)],
      scroll: [Math.round(element.scrollWidth), Math.round(element.scrollHeight)],
      rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
      overflow: [style.overflowX, style.overflowY],
      whiteSpace: style.whiteSpace,
      textOverflow: style.textOverflow,
    };
  };
  const selector = [
    'h1', 'h2', 'h3', 'h4', 'p', 'label', 'button', 'a', 'small',
    '.page-title', '.page-subtitle', '.scene-title', '.scene-subtitle',
    '.manual-card-title-block', '.jimeng-panel-title', '.jimeng-context-label',
    '.scene-layout-button',
    '.filter-tab', '.nav-item-text', '.btn', '.single-select-dropdown-trigger',
  ].join(',');
  const candidates = [...new Set(document.querySelectorAll(selector))].filter(isVisible);
  const issues = [];

  for (const element of candidates) {
    const style = getComputedStyle(element);
    const hasText = directText(element) || /^(H1|H2|H3|H4|P|LABEL|BUTTON|A|SMALL)$/.test(element.tagName);
    if (!hasText) continue;
    const horizontalClip = element.scrollWidth > element.clientWidth + 2
      && style.textOverflow !== 'ellipsis'
      && style.overflowX !== 'auto'
      && style.overflowX !== 'scroll';
    const verticalClip = element.scrollHeight > element.clientHeight + 2
      && style.overflowY !== 'auto'
      && style.overflowY !== 'scroll';
    if (horizontalClip) issues.push(describe(element, 'horizontal-text-overflow'));
    if (verticalClip) issues.push(describe(element, 'vertical-text-overflow'));
    const rect = element.getBoundingClientRect();
    if (rect.left < -2 || (document.body.scrollWidth <= innerWidth + 2 && rect.right > innerWidth + 2)) {
      issues.push(describe(element, 'horizontal-viewport-escape'));
    }
    if (rect.top < -2 && scrollY < 2) issues.push(describe(element, 'top-viewport-escape'));
  }

  const overlapParents = document.querySelectorAll([
    '.manual-card-header', '.jimeng-panel-title', '.jimeng-hero',
    '.account-selection-toolbar', '.codex-overview-selection-bar',
    '.page-header', '.page-tabs-row',
  ].join(','));
  for (const parent of overlapParents) {
    if (!isVisible(parent)) continue;
    const children = [...parent.children].filter(isVisible);
    for (let left = 0; left < children.length; left += 1) {
      for (let right = left + 1; right < children.length; right += 1) {
        const a = children[left].getBoundingClientRect();
        const b = children[right].getBoundingClientRect();
        const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (x > 2 && y > 2) {
          issues.push(describe(parent, 'direct-children-overlap'));
        }
      }
    }
  }

  return {
    title: document.title,
    bodySize: [document.body.scrollWidth, document.body.scrollHeight],
    viewport: [innerWidth, innerHeight],
    issueCount: issues.length,
    issues,
    jimengIconCount: document.querySelectorAll('img.jimeng-model-icon, img.jimeng-hero-logo').length,
    manualCardCount: document.querySelectorAll('.manual-card').length,
  };
})()`;

const cases = [
  { name: 'manual-night-wide', route: 'manual', theme: 'night', width: 1440, height: 900, scale: 'normal' },
  { name: 'manual-day-medium', route: 'manual', theme: 'day', width: 1100, height: 760, scale: 'large' },
  { name: 'manual-night-narrow', route: 'manual', theme: 'night', width: 820, height: 720, scale: 'xlarge' },
  { name: 'jimeng-night-wide', route: 'jimeng', theme: 'night', width: 1440, height: 900, scale: 'normal' },
  { name: 'jimeng-day-medium', route: 'jimeng', theme: 'day', width: 1100, height: 760, scale: 'large' },
  { name: 'jimeng-night-narrow', route: 'jimeng', theme: 'night', width: 820, height: 720, scale: 'xlarge' },
  { name: 'dashboard-day-medium', route: 'dashboard', theme: 'day', width: 1100, height: 760, scale: 'large' },
  { name: 'dashboard-data-night-wide', route: 'dashboard-data', theme: 'night', width: 1900, height: 1000, scale: 'normal' },
  { name: 'dashboard-data-night-medium', route: 'dashboard-data', theme: 'night', width: 1100, height: 760, scale: 'large' },
  { name: 'dashboard-data-night-narrow', route: 'dashboard-data', theme: 'night', width: 760, height: 720, scale: 'xlarge' },
];

await mkdir(outputDir, { recursive: true });
const { socket, send } = await connect();
const results = [];

try {
  await send('Page.enable');
  await send('Runtime.enable');
  for (const item of cases) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: item.width,
      height: item.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const url = `${baseUrl}/?visual-review=${item.route}&visual-theme=${item.theme}`;
    await send('Page.navigate', { url });
    await waitFor(send, `document.readyState === 'complete' && Boolean(document.querySelector('#root > *'))`);
    await sleep(850);
    await evaluate(send, `(() => {
      document.querySelector('.startup-greeting')?.remove();
      document.documentElement.dataset.uiScale = ${JSON.stringify(item.scale === 'normal' ? '1' : item.scale === 'large' ? '1.35' : '1.6')};
      document.documentElement.dataset.uiScaleBand = ${JSON.stringify(item.scale)};
      if (${JSON.stringify(item.route)} === 'manual') {
        document.querySelectorAll('.manual-card-header[aria-expanded="false"]').forEach((element) => element.click());
      }
      if (${JSON.stringify(item.route)} === 'jimeng') {
        [...document.querySelectorAll('.jimeng-tabs button')].find((element) => element.textContent?.includes('账号'))?.click();
      }
      if (${JSON.stringify(item.route)} === 'dashboard-data') {
        document.querySelector('.launchpad-secondary')?.click();
      }
    })()`);
    await sleep(500);
    const audit = await evaluate(send, auditExpression);
    const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(path.join(outputDir, `${item.name}.png`), Buffer.from(screenshot.data, 'base64'));
    results.push({ ...item, url, ...audit });
    console.log(`${item.name}: ${audit.issueCount} issue(s), icon=${audit.jimengIconCount}`);
  }
} finally {
  socket.close();
}

await writeFile(path.join(outputDir, 'report.json'), `${JSON.stringify(results, null, 2)}\n`);
if (results.some((item) => item.issueCount > 0)) process.exitCode = 1;
