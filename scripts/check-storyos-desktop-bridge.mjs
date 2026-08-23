import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sidecarName = '../sidecars/storyos-workspace/bin/storyos-workspace';

function fail(message) {
  console.error(`StoryOS desktop bridge check failed: ${message}`);
  process.exit(1);
}

function readJson(relativePath) {
  const filePath = path.join(repoRoot, relativePath);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readText(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

for (const configPath of ['src-tauri/tauri.conf.json', 'src-tauri/tauri.macos.conf.json']) {
  const tauri = readJson(configPath);
  const externalBin = tauri?.bundle?.externalBin;
  if (!Array.isArray(externalBin) || !externalBin.includes(sidecarName)) {
    fail(`${configPath} must declare ${sidecarName} as an externalBin`);
  }
}

const capability = readJson('src-tauri/capabilities/storyos.json');
if (capability.identifier !== 'storyos-readonly') {
  fail('StoryOS capability identifier must stay storyos-readonly');
}
if (JSON.stringify(capability.windows) !== JSON.stringify(['main'])) {
  fail('StoryOS shell capability must be scoped to the main window only');
}
if (!Array.isArray(capability.permissions) || capability.permissions.length !== 1) {
  fail('StoryOS capability must contain exactly one permission block');
}

const permission = capability.permissions[0];
if (permission.identifier !== 'shell:allow-execute') {
  fail('StoryOS capability may only grant shell:allow-execute');
}
if (!Array.isArray(permission.allow) || permission.allow.length !== 5) {
  fail('StoryOS execute scope must contain exactly the five audited read-only argument shapes');
}

const expectedShapes = [
  ['snapshot', 'dynamic'],
  ['snapshot', 'dynamic', '--through', 'dynamic'],
  ['entity', 'dynamic', 'dynamic'],
  ['entity', 'dynamic', 'dynamic', '--through', 'dynamic'],
  ['manuscript', 'dynamic', 'dynamic'],
];

const actualShapes = permission.allow.map((entry) => {
  if (entry.name !== sidecarName || entry.sidecar !== true) {
    fail('every StoryOS execute scope entry must target the fixed StoryOS sidecar');
  }
  if (!Array.isArray(entry.args)) {
    fail('StoryOS sidecar arguments must be explicitly enumerated; args=true is forbidden');
  }
  return entry.args.map((arg) => (typeof arg === 'string' ? arg : 'dynamic'));
});

if (JSON.stringify(actualShapes) !== JSON.stringify(expectedShapes)) {
  fail(`StoryOS argument shapes changed unexpectedly: ${JSON.stringify(actualShapes)}`);
}

const capabilityText = readText('src-tauri/capabilities/storyos.json');
for (const forbidden of ['shell:allow-spawn', 'shell:allow-stdin-write', 'shell:allow-kill']) {
  if (capabilityText.includes(forbidden)) {
    fail(`forbidden StoryOS shell permission detected: ${forbidden}`);
  }
}

const entry = readText('storyos/sidecar_main.py');
const storyosImports = entry
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => /^from\s+storyos\.|^import\s+storyos(?:\.|\s|$)/.test(line));
if (JSON.stringify(storyosImports) !== JSON.stringify(['from storyos.workspace_cli import main'])) {
  fail(`desktop sidecar entry point must import only storyos.workspace_cli; got ${JSON.stringify(storyosImports)}`);
}

const bridge = readText('src/services/storyosBridge.ts');
if (!bridge.includes("const STORYOS_SIDECAR = '../sidecars/storyos-workspace/bin/storyos-workspace';")) {
  fail('frontend bridge must keep a fixed StoryOS sidecar program');
}
if (!bridge.includes("'plugin:shell|execute'")) {
  fail('frontend bridge must use execute, not spawn');
}
for (const forbidden of ['plugin:shell|spawn', 'plugin:shell|stdin_write', 'plugin:shell|kill']) {
  if (bridge.includes(forbidden)) {
    fail(`frontend bridge contains forbidden shell operation: ${forbidden}`);
  }
}

console.log('StoryOS desktop bridge security boundary OK');
