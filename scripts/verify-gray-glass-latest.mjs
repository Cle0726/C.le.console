import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CDP_ENDPOINT = process.env.CLE_CDP_ENDPOINT ?? 'http://127.0.0.1:9225/json';
const OUTPUT_DIR = process.env.CLE_UI_QA_DIR
  ?? path.resolve('artifacts', 'gray-liquid-glass-latest');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect() {
  const targets = await (await fetch(CDP_ENDPOINT)).json();
  const target = targets.find((item) => item.type === 'page') ?? targets[0];
  if (!target?.webSocketDebuggerUrl) throw new Error('No debuggable C.le. page target found.');

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let sequence = 0;
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject, method } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(`${method}: ${message.error.message}`));
    else resolve(message.result);
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
  let result;
  try {
    result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
  } catch (error) {
    throw new Error(`${error.message}\nExpression: ${expression.slice(0, 420)}`);
  }
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'Runtime evaluation failed.');
  return result.result?.value;
}

async function evaluateInContext(send, contextId, expression) {
  const result = await send('Runtime.evaluate', {
    contextId,
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'Frame evaluation failed.');
  return result.result?.value;
}

function findFrameByUrl(frameTree, urlPart) {
  if (frameTree.frame?.url?.includes(urlPart)) return frameTree.frame;
  for (const child of frameTree.childFrames ?? []) {
    const match = findFrameByUrl(child, urlPart);
    if (match) return match;
  }
  return null;
}

async function waitFor(send, expression, timeoutMs = 15_000, intervalMs = 120) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(send, expression)) return;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

async function screenshot(send, filename) {
  const result = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    fromSurface: true,
  });
  const output = path.join(OUTPUT_DIR, filename);
  await writeFile(output, Buffer.from(result.data, 'base64'));
  return output;
}

const surfaceAuditExpression = `(() => {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 12 && rect.height > 12 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const inspect = (selector) => [...document.querySelectorAll(selector)].filter(visible).map((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      selector,
      className: typeof element.className === 'string' ? element.className : '',
      radius: Number.parseFloat(style.borderTopLeftRadius) || 0,
      background: style.backgroundColor,
      backdrop: style.backdropFilter || style.webkitBackdropFilter || 'none',
      border: style.borderTopWidth + ' ' + style.borderTopColor,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  });
  const buttons = inspect('button:not(.industrial-theme-toggle)');
  const panels = inspect('.main-card,.stat-card,.settings-card,.account-card,.jimeng-panel,.jimeng-studio,.jimeng-canvas-panel,.mm-api-panel,.codex-api-service-panel,.infinite-workspace-bar,.infinite-workspace-nav,.infinite-workspace-stage');
  return {
    page: document.body.innerText.includes('即梦创作 API') ? 'jimeng-api' : document.querySelector('.infinite-workspace-page') ? 'infinite-canvas' : 'dashboard',
    theme: document.documentElement.dataset.visualTheme,
    buttons: {
      count: buttons.length,
      minimumRadius: buttons.length ? Math.min(...buttons.map((item) => item.radius)) : null,
      straight: buttons.filter((item) => item.radius < 10),
    },
    panels: {
      count: panels.length,
      minimumRadius: panels.length ? Math.min(...panels.map((item) => item.radius)) : null,
      straight: panels.filter((item) => item.radius < 18),
      noBlur: panels.filter((item) => item.backdrop === 'none'),
      sample: panels.slice(0, 10),
    },
  };
})()`;

async function openSpatialPage(send, page) {
  await evaluate(send, `document.querySelector('.spatial-nav-avatar')?.click()`);
  await waitFor(send, `document.querySelectorAll('.spatial-nav-item').length >= 2`, 5_000);
  const index = page === 'infinite-canvas' ? 0 : 1;
  await evaluate(send, `document.querySelectorAll('.spatial-nav-item')[${index}]?.click()`);
}

await mkdir(OUTPUT_DIR, { recursive: true });
const { socket, send } = await connect();

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
  });

  await evaluate(send, `(() => {
    localStorage.setItem('cle.visual-theme', 'night');
    localStorage.setItem('cle.performance-mode', 'full');
    return true;
  })()`);
  await send('Page.reload', { ignoreCache: true });

  const startupStartedAt = Date.now();
  await waitFor(send, `document.querySelector('.startup-greeting')?.dataset.startupPhase === 'loading'`, 5_000);
  await sleep(850);
  const startupLoading = await screenshot(send, '01-startup-loading.png');
  const earlyProgress = JSON.parse(await evaluate(send, `JSON.stringify({
    phase: document.querySelector('.startup-greeting')?.dataset.startupPhase,
    progress: document.querySelector('.startup-greeting-meta-bottom strong')?.textContent,
  })`));

  await waitFor(send, `document.querySelector('.startup-greeting')?.dataset.startupPhase === 'ready'`, 10_000);
  const readyAfterMs = Date.now() - startupStartedAt;
  const startupReady = await screenshot(send, '02-startup-ready.png');
  await waitFor(send, `!document.querySelector('.startup-greeting')`, 5_000);
  const completeAfterMs = Date.now() - startupStartedAt;

  await sleep(500);
  const dashboard = await screenshot(send, '03-dashboard.png');
  const dashboardAudit = JSON.parse(await evaluate(send, `JSON.stringify(${surfaceAuditExpression})`));

  await openSpatialPage(send, 'jimeng-api');
  await waitFor(send, `Boolean(document.querySelector('.jimeng-page'))`, 20_000);
  await sleep(1_200);
  const jimengApi = await screenshot(send, '04-jimeng-api.png');
  const jimengAudit = JSON.parse(await evaluate(send, `JSON.stringify(${surfaceAuditExpression})`));

  await openSpatialPage(send, 'infinite-canvas');
  await waitFor(send, `Boolean(document.querySelector('.infinite-workspace-page'))`, 20_000);
  await waitFor(send, `Boolean(document.querySelector('.infinite-workspace-frame'))`, 20_000);
  await sleep(2_000);
  const infiniteCanvas = await screenshot(send, '05-infinite-canvas.png');
  const infiniteAudit = JSON.parse(await evaluate(send, `JSON.stringify(${surfaceAuditExpression})`));
  const frameSource = await evaluate(send, `document.querySelector('.infinite-workspace-frame')?.src ?? null`);

  const { frameTree } = await send('Page.getFrameTree');
  const canvasListFrame = findFrameByUrl(frameTree, '/static/canvas-list.html');
  let infiniteFrameAudit = null;
  if (canvasListFrame) {
    const isolated = await send('Page.createIsolatedWorld', {
      frameId: canvasListFrame.id,
      worldName: 'cle-gray-glass-qa',
      grantUniveralAccess: false,
    });
    infiniteFrameAudit = await evaluateInContext(send, isolated.executionContextId, `(() => {
      const inspect = (selector) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const style = getComputedStyle(element);
        return {
          selector,
          radius: style.borderRadius,
          background: style.backgroundColor,
          backdrop: style.backdropFilter || style.webkitBackdropFilter || 'none',
          border: style.borderTopWidth + ' ' + style.borderTopColor,
        };
      };
      return {
        themeClasses: document.documentElement.className + ' / ' + document.body.className,
        sharedStylesheetLoaded: [...document.styleSheets].some((sheet) => sheet.href?.includes('liquid-glass-gray.css')),
        sidebar: inspect('.ws-sidebar'),
        topbar: inspect('.ws-topbar'),
        card: inspect('.ws-card'),
        cardMeta: inspect('.ws-card-meta'),
        board: inspect('.ws-board'),
      };
    })()`);
  }

  await send('Emulation.setDeviceMetricsOverride', {
    width: 900,
    height: 600,
    deviceScaleFactor: 1.25,
    mobile: false,
  });
  await send('Page.reload', { ignoreCache: true });
  await waitFor(send, `document.querySelector('.startup-greeting')?.dataset.startupPhase === 'loading'`, 5_000);
  await sleep(850);
  const startupCompact = await screenshot(send, '06-startup-compact-125.png');
  const startupTypeAudit = JSON.parse(await evaluate(send, `JSON.stringify((() => {
    const selectors = [
      '.startup-greeting-content',
      '.startup-greeting h1',
      '.startup-greeting-stages',
      '.startup-greeting-meta-top',
      '.startup-greeting-meta-bottom',
    ];
    const elements = selectors.map((selector) => {
      const element = document.querySelector(selector);
      const rect = element?.getBoundingClientRect();
      return {
        selector,
        text: element?.textContent?.trim() ?? null,
        rect: rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null,
        insideViewport: Boolean(rect && rect.left >= -1 && rect.top >= -1 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1),
      };
    });
    const title = document.querySelector('.startup-greeting h1')?.textContent ?? '';
    return {
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      title,
      correctName: title.includes('才酷') && !title.includes('菜酷'),
      documentOverflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight,
      elements,
      allInsideViewport: elements.every((item) => item.insideViewport),
    };
  })())`));

  const report = {
    generatedAt: new Date().toISOString(),
    latestFeatureProof: {
      jimengApiRendered: Boolean(jimengAudit),
      infiniteCanvasRendered: Boolean(infiniteAudit),
      infiniteCanvasFrameSource: frameSource,
    },
    startup: {
      earlyProgress,
      readyAfterMs,
      completeAfterMs,
      minimumFullSequencePassed: readyAfterMs >= 5_000 && completeAfterMs >= 6_000,
    },
    audits: {
      dashboard: dashboardAudit,
      jimengApi: jimengAudit,
      infiniteCanvas: infiniteAudit,
      infiniteCanvasFrame: infiniteFrameAudit,
      startupType: startupTypeAudit,
    },
    screenshots: { startupLoading, startupReady, dashboard, jimengApi, infiniteCanvas, startupCompact },
  };

  await writeFile(path.join(OUTPUT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  socket.close();
}
