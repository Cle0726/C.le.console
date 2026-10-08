import type { MultiModelAccount, MultiModelAccountUsage, MultiModelDefinition, XaiAccountUsage } from '../types/multiModelApi';

export function canRefreshQuota(account: MultiModelAccount): boolean {
  return (account.provider === 'xai' && account.authMode === 'oauth_json')
    || account.source.startsWith('agent2api:')
    || ['cle:workbuddy:', 'cle:antigravity:', 'cle:gemini:', 'cle:kiro:', 'cle:github-copilot:'].some((source) => account.source.startsWith(source))
    || (account.authMode === 'oauth_json' && ['cle:claude:', 'cle:claude-web:'].some((source) => account.source.startsWith(source)));
}

export function quotaStatusLabel(account: MultiModelAccount, usage?: MultiModelAccountUsage, xaiUsage?: XaiAccountUsage): string {
  if (!account.enabled) return '停用';
  const status = xaiUsage?.status ?? usage?.status;
  if (['reauth_required', 'login_required', 'invalid_grant'].includes(status ?? '')) return '需重登';
  if (status === 'pending') return '待授权';
  if (status === 'verification_required') return '需验证';
  if (status === 'forbidden') return '受限制';
  if (xaiUsage?.statusReason || usage?.statusReason || status === 'error') return '刷新异常';
  // Precise balances take precedence: rounding 0.03 credits to 0% must not
  // mark a still-positive account exhausted.
  if (usage?.buckets.length && usage.buckets.every((bucket) => (bucket.remaining ?? bucket.remainingPercent) <= 0)) return '额度已用完';
  if (xaiUsage?.buckets.length && xaiUsage.buckets.every((bucket) => bucket.remaining != null ? bucket.remaining <= 0 : bucket.usedPercent != null && bucket.usedPercent >= 100)) return '额度已用完';
  if (canRefreshQuota(account) && !(xaiUsage?.buckets.length || usage?.buckets.length)) return '待刷新';
  return '已启用';
}

export function preserveModelMetadata(models: MultiModelDefinition[], previous: MultiModelDefinition[]): MultiModelDefinition[] {
  const byId = new Map(previous.map((model) => [model.id, model]));
  return models.map((model) => {
    const old = byId.get(model.id);
    return old ? { ...old, ...model, enabled: old.enabled } : model;
  });
}
