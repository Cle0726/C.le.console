import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sidecarName = '../sidecars/storyos-manuscript/bin/storyos-manuscript';
const tempScope = '$TEMP/cle-storyos-manuscript-*.json';

function fail(message) {
  console.error(`StoryOS manuscript writer check failed: ${message}`);
  process.exit(1);
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

function readText(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

for (const configPath of ['src-tauri/tauri.conf.json', 'src-tauri/tauri.macos.conf.json']) {
  const config = readJson(configPath);
  const bins = config?.bundle?.externalBin;
  if (!Array.isArray(bins) || !bins.includes(sidecarName)) {
    fail(`${configPath} must bundle ${sidecarName}`);
  }
}

const capability = readJson('src-tauri/capabilities/storyos-manuscript.json');
if (capability.identifier !== 'storyos-manuscript-writer') {
  fail('writer capability identifier must stay storyos-manuscript-writer');
}
if (JSON.stringify(capability.windows) !== JSON.stringify(['main'])) {
  fail('writer capability must be scoped to the main window only');
}
if (!Array.isArray(capability.permissions) || capability.permissions.length !== 3) {
  fail('writer capability must contain exactly execute, temp-write and temp-remove permissions');
}

const execute = capability.permissions.find((permission) => permission.identifier === 'shell:allow-execute');
if (!execute || !Array.isArray(execute.allow) || execute.allow.length !== 1) {
  fail('writer may have exactly one shell execute scope');
}
const entry = execute.allow[0];
if (entry.name !== sidecarName || entry.sidecar !== true) {
  fail('writer execute scope must target only the fixed manuscript sidecar');
}
if (!Array.isArray(entry.args) || entry.args.length !== 3) {
  fail('writer execute scope must enumerate exactly save, project and payload arguments');
}
const shapes = entry.args.map((arg) => typeof arg === 'string' ? arg : arg?.validator ?? 'invalid');
const expectedShapes = [
  'save',
  '[^\\r\\n\\u0000]+',
  'cle-storyos-manuscript-[0-9a-f]{32}\\.json',
];
if (JSON.stringify(shapes) !== JSON.stringify(expectedShapes)) {
  fail(`writer argument shapes changed unexpectedly: ${JSON.stringify(shapes)}`);
}

for (const identifier of ['fs:allow-write-text-file', 'fs:allow-remove']) {
  const permission = capability.permissions.find((item) => item.identifier === identifier);
  if (!permission || JSON.stringify(permission.allow) !== JSON.stringify([{ path: tempScope }])) {
    fail(`${identifier} must be scoped only to ${tempScope}`);
  }
}

const capabilityText = readText('src-tauri/capabilities/storyos-manuscript.json');
for (const forbidden of [
  'shell:allow-spawn',
  'shell:allow-stdin-write',
  'shell:allow-kill',
  'fs:allow-write-file',
  'fs:allow-write',
  '$TEMP/**',
  '$HOME',
  '$APPDATA',
  '$DOCUMENT',
]) {
  if (capabilityText.includes(forbidden)) {
    fail(`forbidden permission or broad scope detected: ${forbidden}`);
  }
}

const sidecarEntry = readText('storyos/manuscript_sidecar_main.py');
const imports = sidecarEntry
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => /^from\s+storyos\.|^import\s+storyos(?:\.|\s|$)/.test(line));
if (JSON.stringify(imports) !== JSON.stringify(['from storyos.manuscript_working_copy_cli import main'])) {
  fail(`writer entry point must import only manuscript_working_copy_cli; got ${JSON.stringify(imports)}`);
}

for (const sourcePath of [
  'storyos/manuscript_sidecar_main.py',
  'storyos/storyos/manuscript_working_copy_cli.py',
  'storyos/storyos/manuscript_working_copy.py',
]) {
  const source = readText(sourcePath);
  for (const forbidden of [
    'storyos.cli',
    'storyos.claim_review',
    'storyos.materialization',
    'storyos.canon_commit',
    'claim_review',
    'materialization_cli',
    'canon_commit_cli',
  ]) {
    if (source.includes(forbidden)) {
      fail(`${sourcePath} references forbidden mutation surface: ${forbidden}`);
    }
  }
}

const bridge = readText('src/services/storyosManuscriptBridge.ts');
if (!bridge.includes(`const STORYOS_MANUSCRIPT_SIDECAR = '${sidecarName}';`)) {
  fail('frontend writer bridge must keep the fixed manuscript sidecar path');
}
if (!bridge.includes("args: ['save', projectPath, payloadName]")) {
  fail('frontend writer bridge must invoke only the fixed save shape');
}
if (!bridge.includes('BaseDirectory.Temp')) {
  fail('frontend writer payload must use the OS temp base directory');
}

console.log('StoryOS manuscript writer security boundary OK');
