import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const DEFAULT_CONFIG_PATH = path.join(PROJECT_ROOT, 'config.json');
export const EXAMPLE_CONFIG_PATH = path.join(PROJECT_ROOT, 'config.example.json');
export const RUNTIME_STATE_PATH = path.join(PROJECT_ROOT, 'runtime-state.json');

export function loadConfig(configPath = process.env.MULTI_PROXY_CONFIG || DEFAULT_CONFIG_PATH) {
  if (!fs.existsSync(configPath)) {
    fs.copyFileSync(EXAMPLE_CONFIG_PATH, configPath);
  }
  const raw = fs.readFileSync(configPath, 'utf8');
  const config = JSON.parse(raw);
  return normalizeConfig(config);
}

export function saveConfig(config, configPath = process.env.MULTI_PROXY_CONFIG || DEFAULT_CONFIG_PATH) {
  const normalized = normalizeConfig(config);
  fs.writeFileSync(configPath, JSON.stringify(normalized, null, 2), 'utf8');
  return normalized;
}

export function normalizeConfig(config) {
  const next = structuredClone(config || {});
  next.listenHost = String(next.listenHost || '127.0.0.1');
  next.listenPort = clamp(Number(next.listenPort || 13978), 1, 65535);
  next.adminToken = String(next.adminToken || 'local-admin-token');
  next.requireApiKey = Boolean(next.requireApiKey);
  next.localApiKeys = Array.isArray(next.localApiKeys)
    ? [...new Set(next.localApiKeys.map((key) => String(key).trim()).filter(Boolean))]
    : [];
  next.defaultModel = String(next.defaultModel || 'coding-auto');
  next.errorPolicy = {
    maxRetries: clamp(Number(next.errorPolicy?.maxRetries || 3), 1, 20),
    cooldownSeconds: clamp(Number(next.errorPolicy?.cooldownSeconds || 60), 1, 86400),
    requestTimeoutMs: clamp(Number(next.errorPolicy?.requestTimeoutMs || 120000), 1000, 600000),
  };
  next.proxies = Array.isArray(next.proxies) ? next.proxies.map(normalizeProxy) : [{ id: 'direct', label: 'DIRECT', type: 'direct' }];
  next.providers = Array.isArray(next.providers) ? next.providers.map(normalizeProvider) : [];
  next.accounts = Array.isArray(next.accounts) ? next.accounts.map(normalizeAccount).filter(Boolean) : [];
  next.models = Array.isArray(next.models) ? next.models.map(normalizeModel).filter(Boolean) : [];
  return next;
}

export function inferModelCapabilities(model) {
  const explicit = normalizeCapabilities(model?.capabilities);
  if (explicit.length) return explicit;

  const names = [];
  if (model?.id) names.push(model.id);
  if (model?.upstreamModel) names.push(model.upstreamModel);
  if (Array.isArray(model?.candidates)) {
    names.push(...model.candidates.map((candidate) => candidate?.model).filter(Boolean));
  }

  const hasImage = names.some((value) => looksLikeImageModel(value));
  const hasChat = names.some((value) => value && !looksLikeImageModel(value));

  if (hasImage && !hasChat) return ['image'];
  if (hasImage && hasChat) return ['chat'];
  return ['chat'];
}

function normalizeProxy(proxy) {
  return {
    id: String(proxy.id || '').trim(),
    label: String(proxy.label || proxy.id || '').trim(),
    type: ['direct', 'http', 'socks5'].includes(proxy.type) ? proxy.type : 'direct',
    url: proxy.url ? String(proxy.url).trim() : undefined,
  };
}

function normalizeProvider(provider) {
  return {
    id: String(provider.id || '').trim(),
    label: String(provider.label || provider.id || '').trim(),
    kind: String(provider.kind || 'openai_compatible').trim(),
    enabled: provider.enabled !== false,
    baseUrl: provider.baseUrl ? String(provider.baseUrl).replace(/\/+$/, '') : undefined,
    defaultProxyId: provider.defaultProxyId ? String(provider.defaultProxyId).trim() : undefined,
    timeoutMs: clamp(Number(provider.timeoutMs || 120000), 1000, 600000),
    transport: provider.transport || undefined,
  };
}

function normalizeAccount(account) {
  const id = String(account.id || '').trim();
  const providerId = String(account.providerId || '').trim();
  if (!id || !providerId) return null;
  return {
    id,
    providerId,
    label: String(account.label || id).trim(),
    enabled: account.enabled !== false,
    priority: Number(account.priority || 0),
    proxyId: account.proxyId ? String(account.proxyId).trim() : undefined,
    dailyLimit: account.dailyLimit ? Number(account.dailyLimit) : undefined,
    auth: account.auth || { type: 'api_key' },
  };
}

function normalizeModel(model) {
  const id = String(model.id || '').trim();
  if (!id) return null;
  const candidates = Array.isArray(model.candidates)
    ? model.candidates
      .map((candidate) => ({
        providerId: String(candidate.providerId || '').trim(),
        model: String(candidate.model || '').trim(),
        accountIds: Array.isArray(candidate.accountIds) ? candidate.accountIds.map(String) : undefined,
      }))
      .filter((candidate) => candidate.providerId && candidate.model)
    : undefined;
  return {
    id,
    label: model.label ? String(model.label).trim() : undefined,
    providerId: model.providerId ? String(model.providerId).trim() : undefined,
    upstreamModel: model.upstreamModel ? String(model.upstreamModel).trim() : undefined,
    strategy: model.strategy || 'round_robin',
    capabilities: inferModelCapabilities({
      id,
      upstreamModel: model.upstreamModel,
      capabilities: model.capabilities,
      candidates,
    }),
    candidates,
  };
}

function normalizeCapabilities(raw) {
  const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return [...new Set(items.map((item) => String(item).trim().toLowerCase()).filter((item) => item === 'chat' || item === 'image'))];
}

function looksLikeImageModel(value) {
  const text = String(value || '').trim().toLowerCase();
  return text.startsWith('gpt-image-') || text.includes('-image') || text.startsWith('dall-e');
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
