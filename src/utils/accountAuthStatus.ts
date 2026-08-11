const LOGIN_REQUIRED_MARKERS = [
  'login_required',
  'authentication required',
  'unauthenticated',
  'session expired',
  'token expired',
  'invalid refresh token',
  'missing refresh token',
  're-login',
  'relogin',
  '重新登录',
  '会话已过期',
  '未认证',
  '缺少 refresh_token',
];

const BLOCKING_STATUS_MARKERS = new Set([
  'banned',
  'disabled',
  'forbidden',
  'deactivated',
  'deactivated_workspace',
  'verification_required',
  'validation_required',
]);

export function isAccountLoginRequired(
  status: string | null | undefined,
  ...messages: Array<string | null | undefined>
): boolean {
  const normalizedStatus = status?.trim().toLowerCase();
  if (normalizedStatus === 'login_required' || normalizedStatus === 'reauth_required') {
    return true;
  }

  const haystack = messages
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
    .toLowerCase();
  return LOGIN_REQUIRED_MARKERS.some((marker) => haystack.includes(marker));
}

export function isAccountRefreshError(status: string | null | undefined): boolean {
  const normalizedStatus = status?.trim().toLowerCase();
  return normalizedStatus === 'error' || normalizedStatus === 'failed' || normalizedStatus === 'invalid';
}

export function isAccountRouteBlocked(
  status: string | null | undefined,
  ...messages: Array<string | null | undefined>
): boolean {
  const normalizedStatus = status?.trim().toLowerCase();
  if (normalizedStatus && BLOCKING_STATUS_MARKERS.has(normalizedStatus)) {
    return true;
  }
  if (isAccountLoginRequired(status, ...messages)) {
    return true;
  }

  const haystack = messages
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
    .toLowerCase();
  return Array.from(BLOCKING_STATUS_MARKERS).some((marker) => haystack.includes(marker));
}
