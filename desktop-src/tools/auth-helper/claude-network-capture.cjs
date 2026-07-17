const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');

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
const outputFile = args['output-file'];
const cookieFile = args['cookie-file'];
const startUrl = args.url || 'https://claude.ai/new';

if (!userDataDir || !outputFile) {
  console.error('Missing required args: --user-data-dir, --output-file');
  process.exit(2);
}

fs.mkdirSync(userDataDir, { recursive: true });
fs.mkdirSync(path.dirname(outputFile), { recursive: true });
app.setName('Claude Network Capture');
app.setPath('userData', userDataDir);
app.setPath('sessionData', userDataDir);
app.setPath('logs', path.join(userDataDir, 'Logs'));

function append(record) {
  fs.appendFileSync(outputFile, `${JSON.stringify(record)}\n`, 'utf8');
}

function isClaudeCookie(cookie) {
  const domain = String(cookie.domain || '').toLowerCase();
  return domain === 'claude.ai' ||
    domain === '.claude.ai' ||
    domain.endsWith('.claude.ai') ||
    domain === 'claude.com' ||
    domain === '.claude.com' ||
    domain.endsWith('.claude.com');
}

function cookieUrl(cookie) {
  const domain = String(cookie.domain || 'claude.ai').trim().replace(/^\./, '') || 'claude.ai';
  const cookiePath = String(cookie.path || '/').trim() || '/';
  return `https://${domain}${cookiePath.startsWith('/') ? cookiePath : `/${cookiePath}`}`;
}

async function importCookiesFromFile(file) {
  if (!file) {
    return;
  }
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cookies = Array.isArray(payload.cookies) ? payload.cookies : [];
  for (const cookie of cookies) {
    if (!cookie || !cookie.name || !cookie.value || !isClaudeCookie(cookie)) {
      continue;
    }
    const imported = {
      url: cookieUrl(cookie),
      name: String(cookie.name),
      value: String(cookie.value),
      domain: cookie.domain || undefined,
      path: cookie.path || '/',
      secure: cookie.secure !== false,
      httpOnly: Boolean(cookie.httpOnly),
    };
    if (cookie.expirationDate) {
      imported.expirationDate = Number(cookie.expirationDate);
    }
    if (cookie.sameSite && cookie.sameSite !== 'unspecified') {
      imported.sameSite = cookie.sameSite;
    }
    await session.defaultSession.cookies.set(imported);
  }
}

app.whenReady().then(async () => {
  await importCookiesFromFile(cookieFile);

  const filter = {
    urls: ['https://claude.ai/api/*'],
  };

  session.defaultSession.webRequest.onBeforeRequest(filter, (details, callback) => {
    let requestBody = undefined;
    if (Array.isArray(details.uploadData) && details.uploadData.length > 0) {
      requestBody = details.uploadData
        .map((item) => {
          if (item.bytes) {
            return Buffer.from(item.bytes).toString('utf8');
          }
          if (item.file) {
            return `[file:${item.file}]`;
          }
          return '';
        })
        .join('');
    }
    append({
      phase: 'before',
      ts: new Date().toISOString(),
      method: details.method,
      url: details.url,
      resourceType: details.resourceType,
      requestBody,
    });
    callback({ cancel: false });
  });

  session.defaultSession.webRequest.onCompleted(filter, (details) => {
    append({
      phase: 'completed',
      ts: new Date().toISOString(),
      method: details.method,
      url: details.url,
      resourceType: details.resourceType,
      statusCode: details.statusCode,
    });
  });

  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    title: 'Claude Network Capture',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: false,
    },
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    append({
      phase: 'load-failed',
      ts: new Date().toISOString(),
      errorCode,
      errorDescription,
      url: validatedURL,
    });
  });

  win.webContents.on('did-finish-load', () => {
    append({
      phase: 'page-loaded',
      ts: new Date().toISOString(),
      url: win.webContents.getURL(),
      title: win.getTitle(),
    });
  });

  win.on('closed', () => {
    app.quit();
  });

  await win.loadURL(startUrl);
});
