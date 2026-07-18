interface ProviderPresetLinkMetadata {
  isPartner?: boolean;
  website?: string;
  apiKeyUrl?: string;
}

const PROMOTIONAL_QUERY_KEYS = new Set([
  'aff',
  'affiliate',
  'ref',
  'referral',
  'invite',
  'invitecode',
  'source',
  'from',
  'ch',
  'ic',
  'ytag',
  'ac',
  'rc',
]);

function containsPromotionalTracking(rawUrl?: string): boolean {
  const value = rawUrl?.trim();
  if (!value) return false;

  try {
    const url = new URL(value);
    return Array.from(url.searchParams.keys()).some((rawKey) => {
      const key = rawKey.toLowerCase();
      return PROMOTIONAL_QUERY_KEYS.has(key) || key.startsWith('utm_');
    });
  } catch {
    return false;
  }
}

/** Keep neutral provider conveniences while excluding affiliate/partner placements. */
export function isNeutralProviderPreset(preset: ProviderPresetLinkMetadata): boolean {
  return !preset.isPartner
    && !containsPromotionalTracking(preset.website)
    && !containsPromotionalTracking(preset.apiKeyUrl);
}
