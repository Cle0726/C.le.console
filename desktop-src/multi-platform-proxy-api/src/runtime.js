import fs from 'node:fs';
import path from 'node:path';
import { RUNTIME_STATE_PATH } from './config.js';

export class RuntimeStateStore {
  constructor(filePath = RUNTIME_STATE_PATH) {
    this.filePath = filePath;
    this.states = new Map();
    this.cursors = new Map();
    this.load();
  }

  list() {
    return [...this.states.values()];
  }

  get(accountId) {
    return this.states.get(accountId);
  }

  ensure(account) {
    const usageDate = new Date().toISOString().slice(0, 10);
    let state = this.states.get(account.id);
    if (!state) {
      state = {
        accountId: account.id,
        providerId: account.providerId,
        status: 'healthy',
        todayCalls: 0,
        usageDate,
        cooldownUntil: null,
        lastError: null,
        lastSuccessAt: null,
        lastFailureKind: null,
        lastStatusCode: null,
        consecutiveFailures: 0,
      };
      this.states.set(account.id, state);
    } else if (!state.usageDate) {
      state.usageDate = usageDate;
    } else if (state.usageDate !== usageDate) {
      state.todayCalls = 0;
      state.usageDate = usageDate;
      state.cooldownUntil = null;
      state.consecutiveFailures = 0;
      if (!['invalid', 'disabled'].includes(state.status)) state.status = 'healthy';
    }
    return state;
  }

  pickAccounts(providerId, accounts, accountIds) {
    const now = Date.now();
    let candidates = accounts.filter((account) => {
      if (account.providerId !== providerId || account.enabled === false) return false;
      if (accountIds?.length && !accountIds.includes(account.id)) return false;
      const state = this.ensure(account);
      if (['invalid', 'disabled', 'exhausted'].includes(state.status)) return false;
      if (state.cooldownUntil && new Date(state.cooldownUntil).getTime() > now) return false;
      if (account.dailyLimit && state.todayCalls >= account.dailyLimit) return false;
      return true;
    });
    candidates = candidates.sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0));
    if (candidates.length <= 1) return candidates;
    const cursor = this.cursors.get(providerId) || 0;
    const rotated = [...candidates.slice(cursor % candidates.length), ...candidates.slice(0, cursor % candidates.length)];
    this.cursors.set(providerId, (cursor + 1) % candidates.length);
    return rotated;
  }

  markSuccess(account, meta = {}) {
    const state = this.ensure(account);
    state.status = 'healthy';
    state.todayCalls += 1;
    state.cooldownUntil = null;
    state.lastError = null;
    state.lastFailureKind = null;
    state.lastSuccessAt = new Date().toISOString();
    state.lastStatusCode = meta.statusCode || 200;
    state.lastProviderLabel = meta.providerLabel;
    state.lastUpstreamModel = meta.upstreamModel;
    state.consecutiveFailures = 0;
    this.save();
  }

  markFailure(account, kind, error, options = {}) {
    const state = this.ensure(account);
    state.lastError = error instanceof Error ? error.message : String(error);
    state.lastFailureKind = kind;
    state.lastStatusCode = error?.status || null;
    state.consecutiveFailures = Number(state.consecutiveFailures || 0) + 1;
    if (kind === 'invalid_session') state.status = 'invalid';
    else if (kind === 'quota_exceeded') state.status = 'exhausted';
    else if (['rate_limited', 'cloudflare_block', 'risk_control_block'].includes(kind)) {
      state.status = 'cooling_down';
      state.cooldownUntil = new Date(Date.now() + Number(options.cooldownSeconds || 60) * 1000).toISOString();
    }
    this.save();
  }

  reset() {
    this.states = new Map();
    this.save();
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.states = new Map((Array.isArray(parsed) ? parsed : []).map((item) => [item.accountId, item]));
    } catch {
      this.states = new Map();
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.list(), null, 2), 'utf8');
  }
}
