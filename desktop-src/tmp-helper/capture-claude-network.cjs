const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const userDataDir = process.argv[2];
const logFile = process.argv[3];
const startUrl = process.argv[4] || 'https://claude.ai/new';

if (!userDataDir || !logFile) {
  console.error('usage: capture-claude-network <userDataDir> <logFile> [url]');
  process.exit(2);
}

fs.mkdirSync(userDataDir, { recursive: true });
fs.mkdirSync(path.dirname(logFile), { recursive: true });
fs.writeFileSync(logFile, '');

app.setName('Claude Network Capture');
app.setPath('userData', userDataDir);
app.setPath('logs', path.join(userDataDir, 'Logs'));

function append(event) {
  fs.appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, 'utf8');
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });

  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  await dbg.sendCommand('Network.enable');

  dbg.on('message', async (_event, method, params) => {
    if (method === 'Network.requestWillBeSent') {
      const url = String(params?.request?.url || '');
      if (url.includes('claude.ai/api')) {
        append({ type: 'request', requestId: params.requestId, request: { url, method: params.request?.method || 'GET' } });
      }
    }
    if (method === 'Network.responseReceived') {
      const url = String(params?.response?.url || '');
      if (url.includes('claude.ai/api')) {
        append({ type: 'response', requestId: params.requestId, response: { url, status: params.response?.status || 0, mimeType: params.response?.mimeType || '' } });
      }
    }
  });

  win.on('closed', () => app.quit());
  await win.loadURL(startUrl);
  append({ type: 'ready', url: win.webContents.getURL() });
});

app.on('window-all-closed', () => app.quit());
