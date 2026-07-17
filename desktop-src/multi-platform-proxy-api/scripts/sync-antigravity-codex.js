import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { inferModelCapabilities } from '../src/config.js';

const projectRoot = path.resolve(import.meta.dirname, '..');
const configPath = path.join(projectRoot, 'config.json');
const cockpitDir = path.join(process.env.USERPROFILE || 'C:/Users/34786', '.antigravity_cockpit');
const sidecarConfigPath = path.join(cockpitDir, 'codex_local_access_sidecar', 'config.json');
const sidecarManifestPath = path.join(cockpitDir, 'codex_local_access_sidecar', 'manifest.json');

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const sidecarConfig = JSON.parse(fs.readFileSync(sidecarConfigPath, 'utf8'));
const manifest = JSON.parse(fs.readFileSync(sidecarManifestPath, 'utf8'));
const manifestBackupPath = `${sidecarManifestPath}.bak-${Date.now()}`;

const legacyApiKey = sidecarConfig['api-keys']?.[0];
if (!legacyApiKey) throw new Error('codex local access API key not found');

const port = sidecarConfig.port || 13977;
const providerId = 'antigravity-codex-local';
const provider = {
  id: providerId,
  label: 'Antigravity Cockpit Codex Local Access',
  kind: 'openai_compatible',
  enabled: true,
  baseUrl: `http://127.0.0.1:${port}/v1`,
  defaultProxyId: 'direct',
  timeoutMs: 180000,
};
upsertById(config.providers, provider);

sidecarConfig['api-keys'] = Array.isArray(sidecarConfig['api-keys']) ? sidecarConfig['api-keys'] : [];
sidecarConfig['api-key-account-ids'] = sidecarConfig['api-key-account-ids'] || {};
sidecarConfig['api-keys'] = sidecarConfig['api-keys'].filter((key) => !String(key).startsWith('agt_codex_local_'));
for (const key of Object.keys(sidecarConfig['api-key-account-ids'])) {
  if (key.startsWith('agt_codex_local_')) delete sidecarConfig['api-key-account-ids'][key];
}
manifest.apiKeys = Array.isArray(manifest.apiKeys) ? manifest.apiKeys : [];
manifest.apiKeys = manifest.apiKeys.filter((item) => !String(item.key || '').startsWith('agt_codex_local_'));

const syncedAccounts = [];
for (const account of manifest.accounts || []) {
  const authId = account.authId || `${account.id}.json`;
  const perAccountKey = stableApiKey(account.id);
  if (!sidecarConfig['api-keys'].includes(perAccountKey)) sidecarConfig['api-keys'].push(perAccountKey);
  sidecarConfig['api-key-account-ids'][perAccountKey] = [authId];
  upsertByKey(manifest.apiKeys, {
    id: `local_${account.id}`,
    key: perAccountKey,
    label: `Per Account ${account.email || account.id}`,
    enabled: true,
    accountIds: [account.id],
    allowedModels: [],
    excludedModels: [],
  });

  const proxyAccount = {
    id: `antigravity-${account.id}`,
    providerId,
    label: `Antigravity/Codex ${account.email || account.id}`,
    enabled: true,
    priority: account.remainingQuota > 0 ? 100 + Number(account.planRank || 0) : Number(account.planRank || 0),
    auth: { type: 'api_key', apiKey: perAccountKey },
    meta: {
      source: 'codex_local_access_sidecar_manifest',
      authId,
      email: account.email,
      remainingQuota: account.remainingQuota,
      subscriptionExpiryMs: account.subscriptionExpiryMs,
      dedicatedApiKey: true,
    },
  };
  upsertById(config.accounts, proxyAccount);
  syncedAccounts.push({ id: account.id, email: account.email, authId, keySuffix: perAccountKey.slice(-8) });
}

const modelIds = manifest.modelIds || [];
const chatModels = [];
const imageModels = [];

for (const modelId of modelIds) {
  const capabilities = inferModelCapabilities({ id: modelId, upstreamModel: modelId });
  if (capabilities.includes('image')) imageModels.push(modelId);
  else chatModels.push(modelId);
  upsertById(config.models, {
    id: modelId,
    providerId,
    upstreamModel: modelId,
    strategy: 'round_robin',
    capabilities,
  });
}

const smokeModel = chatModels.includes('gpt-5.4-mini') ? 'gpt-5.4-mini' : chatModels[0];
for (const account of manifest.accounts || []) {
  if (!smokeModel) continue;
  upsertById(config.models, {
    id: `antigravity-${account.id.replace(/^codex_/, '').slice(0, 8)}-smoke`,
    strategy: 'fallback',
    capabilities: ['chat'],
    candidates: [{
      providerId,
      model: smokeModel,
      accountIds: [`antigravity-${account.id}`],
    }],
  });
}

upsertById(config.models, {
  id: 'antigravity-auto',
  strategy: 'fallback',
  capabilities: ['chat'],
  candidates: chatModels.map((model) => ({ providerId, model })),
});

if (imageModels.length) {
  upsertById(config.models, {
    id: 'antigravity-image-auto',
    strategy: 'fallback',
    capabilities: ['image'],
    candidates: imageModels.map((model) => ({ providerId, model })),
  });
} else {
  removeById(config.models, 'antigravity-image-auto');
}

fs.copyFileSync(sidecarManifestPath, manifestBackupPath);
fs.writeFileSync(sidecarConfigPath, JSON.stringify(sidecarConfig, null, 2), 'utf8');
fs.writeFileSync(sidecarManifestPath, JSON.stringify(manifest, null, 2), 'utf8');
fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
console.log(JSON.stringify({
  ok: true,
  providerId,
  port,
  accountCount: syncedAccounts.length,
  syncedAccounts,
  models: modelIds,
  chatModels,
  imageModels,
  sidecarConfigUpdated: true,
  sidecarManifestUpdated: true,
  manifestBackupPath,
  note: 'Per-account API keys were written to config.json and manifest.json. Restart Cockpit sidecar for live 13977 to load new keys.',
}, null, 2));

function stableApiKey(accountId) {
  const digest = crypto.createHash('sha256').update(`antigravity-codex-local:${accountId}`).digest('hex').slice(0, 32);
  return `agt_codex_${digest}`;
}

function upsertById(items, next) {
  const index = items.findIndex((item) => item.id === next.id);
  if (index >= 0) items[index] = { ...items[index], ...next };
  else items.push(next);
}

function upsertByKey(items, next) {
  const index = items.findIndex((item) => item.key === next.key || item.id === next.id);
  if (index >= 0) items[index] = { ...items[index], ...next };
  else items.push(next);
}

function removeById(items, id) {
  const index = items.findIndex((item) => item.id === id);
  if (index >= 0) items.splice(index, 1);
}
