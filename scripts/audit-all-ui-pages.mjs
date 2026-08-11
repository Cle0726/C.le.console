import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const endpoint = process.env.CLE_CDP_ENDPOINT ?? 'http://127.0.0.1:9225/json';
const outputDir = process.env.CLE_UI_AUDIT_DIR ?? path.resolve('artifacts', 'all-ui-material-audit');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect() {
  const targets = await (await fetch(endpoint)).json();
  const target = [...targets].reverse().find((item) => item.type === 'page') ?? targets[0];
  if (!target?.webSocketDebuggerUrl) throw new Error('No debuggable page.');
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
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description
      ?? result.exceptionDetails.text
      ?? 'Evaluation failed.',
    );
  }
  return result.result?.value;
}

async function waitFor(send, expression, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(send, expression)) return;
    await sleep(120);
  }
  throw new Error(`Timeout: ${expression}`);
}

const auditExpression = `(() => {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 8 && rect.height > 8 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > .05;
  };
  const alpha = (color) => {
    const match = color.match(/rgba?\\(([^)]+)\\)/);
    if (match) {
      const slashAlpha = match[1].match(/\\/\\s*([\\d.]+)/);
      if (slashAlpha) return Number(slashAlpha[1]);
      const values = match[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return values.length > 3 && Number.isFinite(values[3]) ? values[3] : 1;
    }
    const colorFunction = color.match(/color\\([^/]+\\/\\s*([\\d.]+)\\s*\\)/);
    if (colorFunction) return Number(colorFunction[1]);
    return color === 'transparent' ? 0 : 1;
  };
  const describe = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      tag: element.tagName.toLowerCase(),
      inputType: element instanceof HTMLInputElement ? element.type : null,
      className: typeof element.className === 'string' ? element.className.slice(0, 180) : '',
      text: (element.textContent ?? '').trim().replace(/\\s+/g, ' ').slice(0, 90),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      radius: Number.parseFloat(style.borderTopLeftRadius) || 0,
      background: style.backgroundColor,
      backgroundAlpha: alpha(style.backgroundColor),
      backgroundImage: style.backgroundImage,
      backdrop: style.backdropFilter || style.webkitBackdropFilter || 'none',
      borderWidth: Number.parseFloat(style.borderTopWidth) || 0,
      borderColor: style.borderTopColor,
      shadow: style.boxShadow,
    };
  };
  const controls = [...document.querySelectorAll('button:not(.industrial-theme-toggle),[role="button"],input,textarea,select')]
    .filter(visible).map(describe);
  const excluded = /^(app-container|main-wrapper|main-content|page-container|dashboard-scene|workspace|ws-main|ws-board|infinite-workspace-stage)( |$)/;
  const surfaces = [...document.querySelectorAll('div,section,article,header,nav,aside,footer,main')]
    .filter(visible)
    .map((element) => ({ element, data: describe(element) }))
    .filter(({ data }) => data.width >= 150 && data.height >= 48)
    .filter(({ data }) => !excluded.test(data.className))
    .filter(({ data }) => data.backgroundAlpha > .045 || data.backgroundImage !== 'none' || data.borderWidth > 0 || data.shadow !== 'none')
    .map(({ data }) => data);
  const candidateName = /(card|panel|popover|modal|dialog|menu|toolbar|topbar|sidebar|hero|group|container|notice|tabs|selection-bar|command-bar|empty-state)/;
  const candidateExclusion = /(page$|page\\s|page-|row|header|footer|overlay|ambient|stage|board|grid$)/;
  const glassCandidates = surfaces.filter((item) =>
    candidateName.test(item.className)
    && !candidateExclusion.test(item.className)
    && (item.backgroundAlpha > .045 || item.borderWidth >= .5 || item.shadow !== 'none')
  );
  const nonPanelLayer = /(ambient|page$|page\\s|page-|settings-content|modal-(overlay|header|footer)|infinite-workspace-(page|gate))/;
  const headings = [...document.querySelectorAll('h1,h2,.page-title,.scene-title')]
    .filter(visible).map((element) => (element.textContent ?? '').trim()).filter(Boolean).slice(0, 6);
  const active = document.querySelector('.spatial-nav-item.active .spatial-nav-tooltip')?.textContent?.trim()
    ?? document.querySelector('.spatial-nav-item.active')?.getAttribute('title')
    ?? null;
  return {
    active,
    headings,
    controlCount: controls.length,
    straightControls: controls.filter((item) =>
      !['checkbox', 'radio', 'range'].includes(item.inputType) && item.radius < 10
    ),
    opaqueControls: controls.filter((item) => item.backgroundAlpha >= .92),
    surfaceCount: surfaces.length,
    straightSurfaces: surfaces.filter((item) => item.radius < 10 && !nonPanelLayer.test(item.className)),
    opaqueSurfaces: surfaces.filter((item) => item.backgroundAlpha >= .92 && !nonPanelLayer.test(item.className)),
    noBlurSurfaces: surfaces.filter((item) => item.backdrop === 'none'),
    glassCandidates,
    glassViolations: glassCandidates.filter((item) =>
      item.radius < 10 || item.backgroundAlpha >= .92 || item.backdrop === 'none' || item.borderWidth < .5
    ),
  };
})()`;

async function openSpatial(send) {
  const state = await evaluate(send, `(() => {
    const avatar = document.querySelector('.spatial-nav-avatar');
    const before = avatar?.getAttribute('aria-expanded');
    if (before !== 'true') avatar?.click();
    return { before, exists: Boolean(avatar) };
  })()`);
  await sleep(180);
  const after = await evaluate(send, `JSON.stringify({
    avatarExpanded: document.querySelector('.spatial-nav-avatar')?.getAttribute('aria-expanded'),
    navClass: document.querySelector('.spatial-top-nav')?.className,
    wingCount: document.querySelectorAll('.spatial-nav-wing').length,
  })`);
  if (!JSON.parse(after).wingCount) console.log(JSON.stringify({ openSpatial: state, after: JSON.parse(after) }));
  await waitFor(send, `Boolean(document.querySelector('.spatial-nav-wing'))`, 4_000);
}

async function openMore(send, layout, moreIndex) {
  if (layout === 'classic') {
    await evaluate(send, `document.querySelectorAll('.side-nav .nav-item')[${moreIndex}]?.click()`);
  } else {
    await openSpatial(send);
    await evaluate(send, `document.querySelectorAll('.spatial-nav-wing .spatial-nav-item')[${moreIndex}]?.click()`);
  }
  await waitFor(send, `Boolean(document.querySelector(${JSON.stringify(layout === 'classic' ? '.side-nav-more-popover' : '.spatial-nav-more-panel')}))`, 4_000);
}

async function audit(send, label, kind, index) {
  await sleep(650);
  const result = JSON.parse(await evaluate(send, `JSON.stringify(${auditExpression})`));
  return { label, kind, index, ...result };
}

async function verifyButtonInteraction(send) {
  const target = await evaluate(send, `(() => {
    const element = document.querySelector('.spatial-nav-avatar')
      ?? [...document.querySelectorAll('button:not(:disabled)')].find((button) => {
        const rect = button.getBoundingClientRect();
        return rect.width > 24 && rect.height > 24;
      });
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    element.dataset.materialAuditTarget = 'true';
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      offsetWidth: element.offsetWidth,
      offsetHeight: element.offsetHeight,
      className: element.className,
    };
  })()`);
  if (!target) return { passed: false, reason: 'No visible button target.' };

  const sample = () => evaluate(send, `(() => {
    const element = document.querySelector('[data-material-audit-target="true"]');
    if (!element) return null;
    const style = getComputedStyle(element);
    return {
      className: element.className,
      pointerLit: element.classList.contains('is-pointer-lit'),
      pressed: element.classList.contains('is-glass-pressed'),
      rebound: element.classList.contains('is-glass-rebound'),
      transform: style.transform,
      glowX: element.style.getPropertyValue('--button-glow-x'),
      glowY: element.style.getPropertyValue('--button-glow-y'),
      offsetWidth: element.offsetWidth,
      offsetHeight: element.offsetHeight,
    };
  })()`);

  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y, button: 'none' });
  await sleep(110);
  const hover = await sample();
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(90);
  const press = await sample();
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(70);
  const release = await sample();
  await sleep(460);
  const settled = await sample();
  await evaluate(send, `document.querySelector('[data-material-audit-target="true"]')?.removeAttribute('data-material-audit-target'); document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); true`);

  const dimensions = [hover, press, release, settled].every((state) =>
    state?.offsetWidth === target.offsetWidth && state?.offsetHeight === target.offsetHeight
  );
  return {
    target,
    hover,
    press,
    release,
    settled,
    layoutStable: dimensions,
    passed: Boolean(
      hover?.pointerLit
      && hover?.glowX
      && hover?.glowY
      && press?.pressed
      && release?.rebound
      && !settled?.pressed
      && !settled?.rebound
      && dimensions
    ),
  };
}

await mkdir(outputDir, { recursive: true });
const { socket, send } = await connect();
try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate(send, `localStorage.setItem('cle.visual-theme','night'); localStorage.setItem('cle.performance-mode','full'); true`);
  await send('Page.reload', { ignoreCache: true });
  await waitFor(send, `Boolean(document.querySelector('#root')?.firstElementChild)`, 20_000);
  await waitFor(send, `!document.querySelector('.startup-greeting')`, 14_000);

  const layout = await evaluate(send, `document.querySelector('.side-nav')?.classList.contains('side-nav-classic') ? 'classic' : 'spatial'`);
  const interaction = await verifyButtonInteraction(send);
  if (layout === 'spatial') await openSpatial(send);
  const directSelector = layout === 'classic' ? '.side-nav .nav-item' : '.spatial-nav-wing .spatial-nav-item';
  const directItems = JSON.parse(await evaluate(send, `JSON.stringify([...document.querySelectorAll(${JSON.stringify(directSelector)})].map((element, index) => ({
    index,
    label: element.getAttribute('title') || element.querySelector('.spatial-nav-tooltip,.nav-item-text')?.textContent?.trim() || element.textContent.trim() || 'item-' + index,
    more: element.getAttribute('aria-controls') === 'spatial-navigation-more' || (element.getAttribute('title') || '').includes('更多平台'),
    log: element.classList.contains('spatial-log-button') || (element.getAttribute('title') || '').includes('日志'),
  })))`));

  const results = [await audit(send, '控制中心', 'baseline', -1)];
  for (const item of directItems.filter((entry) => !entry.more)) {
    await evaluate(send, `document.querySelectorAll(${JSON.stringify(directSelector)})[${item.index}]?.click()`);
    results.push(await audit(send, item.label, 'direct', item.index));
    await evaluate(send, `document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    if (layout === 'spatial') await openSpatial(send);
  }

  const moreIndex = directItems.find((entry) => entry.more)?.index;
  let moreItems = [];
  if (Number.isInteger(moreIndex)) {
    const morePanelSelector = layout === 'classic' ? '.side-nav-more-popover' : '.spatial-nav-more-panel';
    await openMore(send, layout, moreIndex);
    moreItems = JSON.parse(await evaluate(send, `JSON.stringify([...document.querySelectorAll(${JSON.stringify(`${morePanelSelector} button`)})].map((element, index) => ({
      index,
      label: element.textContent.trim().replace(/\\s+/g,' ') || 'more-' + index,
      manage: element.classList.contains('side-nav-more-manage'),
    })))`));
    await evaluate(send, `document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);

    for (const item of moreItems) {
      await openMore(send, layout, moreIndex);
      await evaluate(send, `document.querySelectorAll(${JSON.stringify(`${morePanelSelector} button`)})[${item.index}]?.click()`);
      results.push(await audit(send, item.label, item.manage ? 'modal' : 'more', item.index));
      await evaluate(send, `document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    }
  }

  const compact = results.map((page) => ({
    label: page.label,
    kind: page.kind,
    active: page.active,
    headings: page.headings,
    controlCount: page.controlCount,
    straightControls: page.straightControls.slice(0, 12),
    opaqueControls: page.opaqueControls.slice(0, 12),
    surfaceCount: page.surfaceCount,
    straightSurfaces: page.straightSurfaces.slice(0, 20),
    opaqueSurfaces: page.opaqueSurfaces.slice(0, 20),
    noBlurSurfaces: page.noBlurSurfaces.slice(0, 26),
    glassCandidates: page.glassCandidates.slice(0, 40),
    glassViolations: page.glassViolations.slice(0, 40),
  }));
  const report = { generatedAt: new Date().toISOString(), layout, interaction, directItems, moreItems, pages: compact };
  await writeFile(path.join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    pageCount: compact.length,
    pagesWithStraightControls: compact.filter((page) => page.straightControls.length).map((page) => page.label),
    pagesWithStraightSurfaces: compact.filter((page) => page.straightSurfaces.length).map((page) => page.label),
    pagesWithOpaqueSurfaces: compact.filter((page) => page.opaqueSurfaces.length).map((page) => page.label),
    pagesWithGlassViolations: compact.filter((page) => page.glassViolations.length).map((page) => page.label),
    interactionPassed: interaction.passed,
    report: path.join(outputDir, 'report.json'),
  }, null, 2));
} finally {
  socket.close();
}
