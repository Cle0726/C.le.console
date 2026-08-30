export const BEIJING_TIME_ZONE = 'Asia/Shanghai';

/**
 * Calendar fields in Beijing time (UTC+8, no daylight-saving changes).
 * UTC getters deliberately avoid the operating system's configured timezone.
 */
export function getBeijingCalendarFields(value: Date | number = Date.now()) {
  const timestamp = value instanceof Date ? value.getTime() : value;
  const shifted = new Date(timestamp + 8 * 60 * 60 * 1000);
  return {
    hour: shifted.getUTCHours(),
    weekday: shifted.getUTCDay(),
  };
}

export function formatBeijingDate(
  value: Date | number,
  locale: string | undefined,
  options: Intl.DateTimeFormatOptions,
) {
  return new Intl.DateTimeFormat(locale, {
    ...options,
    timeZone: BEIJING_TIME_ZONE,
  }).format(value);
}
