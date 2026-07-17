const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, session, clipboard } = require('electron');

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      result[key] = next;
      i += 1;
    } else {
      result[key] = 'true';
    }
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
const userDataDir = args['user-data-dir'];
const port = Number.parseInt(args.port || '8798', 10);
const token = args.token || '';
const baseUrl = String(args['base-url'] || 'https://claude.ai').replace(/\/$/, '');
const startUrl = args.url || `${baseUrl}/new`;
const stateFile = args['state-file'];

if (!userDataDir || !token) {
  console.error('Missing required args: --user-data-dir, --token');
  process.exit(2);
}

fs.mkdirSync(userDataDir, { recursive: true });
if (stateFile) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
}

app.setName('Claude Browser Bridge');
app.setPath('userData', userDataDir);
app.setPath('sessionData', userDataDir);
app.setPath('logs', path.join(userDataDir, 'Logs'));

let bridgeWindow = null;
let bridgeReady = false;
let lastError = null;
let lastComposeResult = null;

function writeState(extra = {}) {
  if (!stateFile) return;
  const payload = {
    ready: bridgeReady,
    currentUrl: bridgeWindow && !bridgeWindow.webContents.isDestroyed() ? bridgeWindow.webContents.getURL() : null,
    lastError,
    updatedAt: new Date().toISOString(),
    ...extra,
  };
  fs.writeFileSync(stateFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function getAuthSummary() {
  const cookies = await session.defaultSession.cookies.get({});
  const names = cookies.map((cookie) => cookie.name);
  return {
    authenticated: names.includes('sessionKey') && names.includes('lastActiveOrg'),
    cookieNames: names.sort(),
  };
}

function isAuthorized(req, res) {
  const header = String(req.headers.authorization || '');
  const provided = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  if (provided !== token) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return false;
  }
  return true;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

async function executeCompletionInPage({ organizationId, conversationId, payload, appendMessagePayload }) {
  if (!bridgeWindow || bridgeWindow.isDestroyed()) {
    throw new Error('browser bridge window is not available');
  }
  const script = `
    (async () => {
      const organizationId = ${JSON.stringify(organizationId)};
      const conversationId = ${JSON.stringify(conversationId)};
      const payload = ${JSON.stringify(payload)};
      const appendMessagePayload = ${JSON.stringify(appendMessagePayload ?? null)};
      const baseUrl = ${JSON.stringify(baseUrl)};
      const defaultHeaders = {
        'content-type': 'application/json',
        accept: 'text/event-stream, application/json',
        'x-organization-uuid': organizationId,
      };
      let response;
      if (appendMessagePayload) {
        response = await fetch(baseUrl + '/api/append_message', {
          method: 'POST',
          credentials: 'include',
          headers: defaultHeaders,
          body: JSON.stringify(appendMessagePayload),
        });
        if (response.status === 404) {
          const fallbackUrl = baseUrl + '/api/organizations/' + organizationId + '/chat_conversations/' + conversationId + '/completion';
          response = await fetch(fallbackUrl, {
            method: 'POST',
            credentials: 'include',
            headers: defaultHeaders,
            body: JSON.stringify(payload),
          });
        }
      } else {
        const url = baseUrl + '/api/organizations/' + organizationId + '/chat_conversations/' + conversationId + '/completion';
        response = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: defaultHeaders,
          body: JSON.stringify(payload),
        });
      }
      const text = await response.text();
      return {
        status: response.status,
        headers: {
          contentType: response.headers.get('content-type'),
          retryAfter: response.headers.get('retry-after'),
        },
        body: text,
      };
    })();
  `;
  return bridgeWindow.webContents.executeJavaScript(script, true);
}



async function executeComposerInput({ text }) {
  if (!bridgeWindow || bridgeWindow.isDestroyed()) {
    throw new Error('browser bridge window is not available');
  }
  const focused = await bridgeWindow.webContents.executeJavaScript(`
    (() => {
      const editor = document.querySelector('[data-testid="chat-input"], [contenteditable="true"].ProseMirror');
      if (!editor) {
        window.__bridgeLastComposeResult = { ok: false, error: 'chat_input_not_found', at: new Date().toISOString() };
        return false;
      }
      editor.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      editor.textContent = '';
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Process', code: 'Process' }));
      return true;
    })();
  `, true);
  if (!focused) {
    return bridgeWindow.webContents.executeJavaScript('window.__bridgeLastComposeResult', true);
  }
  clipboard.writeText(String(text || ''));
  bridgeWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Control' });
  bridgeWindow.webContents.sendInputEvent({ type: 'char', keyCode: 'V', modifiers: ['control'] });
  bridgeWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Control' });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const typedText = await bridgeWindow.webContents.executeJavaScript(`(() => {
    const editor = document.querySelector('[data-testid="chat-input"], [contenteditable="true"].ProseMirror');
    return editor ? (editor.innerText || editor.textContent || '') : '';
  })()`, true);
  const script = `
    (async () => {
      const editor = document.querySelector('[data-testid="chat-input"], [contenteditable="true"].ProseMirror');
      editor && editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor && editor.dispatchEvent(new Event('change', { bubbles: true }));
      const sendButton = Array.from(document.querySelectorAll('button')).find((btn) => {
        const label = (btn.getAttribute('aria-label') || '').toLowerCase();
        const text = (btn.innerText || '').toLowerCase();
        return !btn.disabled && (
          label.includes('send') ||
          label.includes('submit') ||
          text === 'send'
        );
      });
      if (sendButton) {
        sendButton.click();
        window.__bridgeLastComposeResult = { ok: true, method: 'button', at: new Date().toISOString(), typedText: ${JSON.stringify(typedText)}, editorHtml: editor ? editor.innerHTML : '' };
        return window.__bridgeLastComposeResult;
      }
      const submitHost = editor.closest('form') || editor.parentElement;
      if (submitHost) {
        const submitEvent = new Event('submit', { bubbles: true, cancelable: true });
        submitHost.dispatchEvent(submitEvent);
      }
      if (editor) {
        const enterEvent = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', which: 13, keyCode: 13 });
        editor.dispatchEvent(enterEvent);
        const keypressEvent = new KeyboardEvent('keypress', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', which: 13, keyCode: 13 });
        editor.dispatchEvent(keypressEvent);
        const keyupEvent = new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', which: 13, keyCode: 13 });
        editor.dispatchEvent(keyupEvent);
      }
      window.__bridgeLastComposeResult = { ok: true, method: 'submit_then_enter', at: new Date().toISOString(), typedText: ${JSON.stringify(typedText)}, editorHtml: editor ? editor.innerHTML : '' };
      return window.__bridgeLastComposeResult;
    })();
  `;
  return bridgeWindow.webContents.executeJavaScript(script, true);
}



async function ensureNewChatPage() {
  if (!bridgeWindow || bridgeWindow.isDestroyed()) {
    throw new Error('browser bridge window is not available');
  }
  await bridgeWindow.loadURL(startUrl);
  for (let i = 0; i < 60; i += 1) {
    const ready = await bridgeWindow.webContents.executeJavaScript(`(() => {
      const hasEditor = !!document.querySelector('[data-testid="chat-input"], [contenteditable="true"].ProseMirror');
      const bodyText = document.body.innerText || '';
      const hasConversation = /Claude responded:|Retry|Edit|Copy/.test(bodyText);
      return hasEditor && !hasConversation;
    })()`, true);
    if (ready) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('new_chat_not_ready');
}

async function latestAssistantText() {
  if (!bridgeWindow || bridgeWindow.isDestroyed()) {
    throw new Error('browser bridge window is not available');
  }
  return bridgeWindow.webContents.executeJavaScript(`(() => {
    const bodyText = document.body.innerText || '';
    const idx = bodyText.lastIndexOf('Claude responded:');
    if (idx >= 0) {
      return bodyText.slice(idx).trim();
    }
    const alt = bodyText.lastIndexOf('收到。');
    if (alt >= 0) {
      return bodyText.slice(alt - 200 >= 0 ? alt - 200 : 0).trim();
    }
    return bodyText.slice(-12000).trim();
  })()`, true);
}

async function waitForAssistantResponse(previousText, timeoutMs = 45000) {
  if (!bridgeWindow || bridgeWindow.isDestroyed()) {
    throw new Error('browser bridge window is not available');
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await latestAssistantText();
    if (current && current !== previousText && !/Claude is AI and can make mistakes/i.test(current)) {
      return current;
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  const finalText = await latestAssistantText();
  if (finalText && finalText !== previousText) {
    return finalText;
  }
  throw new Error('assistant_response_timeout');
}

async function inspectPageState() {
  if (!bridgeWindow || bridgeWindow.isDestroyed()) {
    throw new Error('browser bridge window is not available');
  }
  const script = `
    (() => {
      const selectors = {
        textareas: Array.from(document.querySelectorAll('textarea')).map((el) => ({
          tag: el.tagName,
          placeholder: el.getAttribute('placeholder'),
          ariaLabel: el.getAttribute('aria-label'),
          testid: el.getAttribute('data-testid'),
          className: el.className,
          value: el.value?.slice(0, 80) || ''
        })),
        contenteditables: Array.from(document.querySelectorAll('[contenteditable="true"]')).map((el) => ({
          tag: el.tagName,
          ariaLabel: el.getAttribute('aria-label'),
          testid: el.getAttribute('data-testid'),
          className: el.className,
          text: (el.textContent || '').slice(0, 80)
        })),
        buttons: Array.from(document.querySelectorAll('button')).map((el) => ({
          text: (el.innerText || '').trim().slice(0, 80),
          ariaLabel: el.getAttribute('aria-label'),
          testid: el.getAttribute('data-testid'),
          className: el.className,
          disabled: !!el.disabled,
        })).slice(0, 80),
        latestAssistantText: (() => {
          const blocks = Array.from(document.querySelectorAll('[data-testid="assistant-message"], [data-is-streaming="false"]'));
          for (let i = blocks.length - 1; i >= 0; i -= 1) {
            const txt = (blocks[i].innerText || '').trim();
            if (txt) return txt.slice(0, 4000);
          }
          const bodyText = document.body.innerText || '';
          const idx = bodyText.lastIndexOf('Claude responded:');
          return idx >= 0 ? bodyText.slice(idx, idx + 4000) : bodyText.slice(-4000);
        })(),
        path: location.pathname,
        title: document.title,
        lastComposeResult: window.__bridgeLastComposeResult || null,
      };
      return selectors;
    })();
  `;
  return bridgeWindow.webContents.executeJavaScript(script, true);
}

app.whenReady().then(async () => {
  bridgeWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    title: 'Claude Browser Bridge',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: false,
    },
  });

  bridgeWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    lastError = `load_failed ${errorCode} ${errorDescription} ${validatedURL}`;
    writeState();
  });

  bridgeWindow.webContents.on('did-finish-load', async () => {
    bridgeReady = true;
    lastError = null;
    writeState(await getAuthSummary());
  });

  await bridgeWindow.loadURL(startUrl);

  const server = http.createServer(async (req, res) => {
    if (!isAuthorized(req, res)) {
      return;
    }

    try {
      if (req.method === 'GET' && req.url === '/health') {
        const auth = await getAuthSummary();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ready: bridgeReady,
          currentUrl: bridgeWindow && !bridgeWindow.webContents.isDestroyed() ? bridgeWindow.webContents.getURL() : null,
          transport: 'browser_bridge',
          ...auth,
        }));
        return;
      }

      if (req.method === 'POST' && req.url === '/probe') {
        const auth = await getAuthSummary();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(auth));
        return;
      }

      if (req.method === 'POST' && (req.url === '/completion' || req.url === '/append-message')) {
        const payload = await readJson(req);
        const result = await executeCompletionInPage(payload);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      if (req.method === 'GET' && req.url === '/inspect') {
        const info = await inspectPageState();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(info));
        return;
      }

      if (req.method === 'GET' && req.url === '/conversation-text') {
        const info = await bridgeWindow.webContents.executeJavaScript(`(() => ({ text: document.body.innerText }))()`, true);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(info));
        return;
      }

      if (req.method === 'GET' && req.url === '/dom-scan') {
        const info = await bridgeWindow.webContents.executeJavaScript(`(() => {
          return Array.from(document.querySelectorAll('*')).map((el) => ({
            tag: el.tagName,
            testid: el.getAttribute('data-testid'),
            role: el.getAttribute('role'),
            ariaLabel: el.getAttribute('aria-label'),
            className: (el.className && String(el.className)) || '',
            text: (el.innerText || '').trim().slice(0, 200)
          })).filter((item) => item.testid || item.role || item.ariaLabel || /assistant|message|response|ProseMirror|action-bar/i.test(item.className) || item.text).slice(0, 400);
        })()`, true);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(info));
        return;
      }

      if (req.method === 'POST' && req.url === '/composer-send') {
        const payload = await readJson(req);
        const info = await executeComposerInput(payload);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(info));
        return;
      }

      if (req.method === 'POST' && req.url === '/composer-chat') {
        const payload = await readJson(req);
        await ensureNewChatPage();
        const before = await latestAssistantText();
        const sendResult = await executeComposerInput(payload);
        if (!sendResult || sendResult.ok !== true) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'composer_send_failed', detail: sendResult }));
          return;
        }
        const after = await waitForAssistantResponse(before);
        let cleaned = String(after || '')
          .replace(/^Claude responded:\s*/i, '')
          .replace(/\nThought for .*$/gms, '')
          .replace(/Detected encoding corruption;.*$/gms, '')
          .replace(/\n[].*$/gms, '')
          .replace(/\nWant to be notified when Claude responds\?.*$/gms, '')
          .replace(/\nClaude is AI and can make mistakes\. Please double-check responses\..*$/gms, '')
          .replace(/\nShare.*$/gms, '')
          .trim();
        const paras = cleaned.split(/\n\n+/).map((part) => part.trim()).filter(Boolean);
        const seen = new Set();
        cleaned = paras.filter((part) => {
          if (seen.has(part)) return false;
          seen.add(part);
          return true;
        }).join('\n\n');
        writeState({ lastComposerPrompt: (sendResult && sendResult.typedText) || payload.text || null, lastComposerRaw: after, lastComposerCleaned: cleaned });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 200, headers: { contentType: 'application/json' }, body: JSON.stringify({ completion: cleaned }) }));
        return;
      }

      if (req.method === 'POST' && req.url === '/shutdown') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        setTimeout(() => app.quit(), 50);
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found', method: req.method, url: req.url }));
    } catch (error) {
      lastError = String(error && error.message ? error.message : error);
      writeState();
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: lastError }));
    }
  });

  server.listen(port, '127.0.0.1', () => {
    writeState({ port });
  });

  app.on('before-quit', () => {
    server.close();
  });
});
