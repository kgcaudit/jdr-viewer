/**
 * Windows SYSTEMTIME(u16 × 8) 처리.
 *
 * 이 값에는 타임존 정보가 없다. 기기가 기록한 벽시계 시각 그대로다.
 * 브라우저 로컬 타임존을 적용하면 보는 사람마다 값이 달라지므로,
 * Date.UTC로 epoch ms를 만들고 표시할 때도 UTC 게터를 쓴다.
 * 결과적으로 "기록된 숫자를 그대로" 보여준다.
 */

export const INVALID_TIME = NaN;

export function systemTimeToMs(
  year: number, month: number, day: number,
  hour: number, minute: number, second: number, millis: number,
): number {
  if (
    year < 1970 || year > 2200 ||
    month < 1 || month > 12 ||
    day < 1 || day > 31 ||
    hour > 23 || minute > 59 || second > 59 || millis > 999
  ) {
    return INVALID_TIME;
  }
  return Date.UTC(year, month - 1, day, hour, minute, second, millis);
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

/** 기록된 벽시계 시각을 그대로 문자열로. */
export function formatRecordedTime(ms: number, withMillis = true): string {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const base =
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return withMillis ? `${base}.${pad(d.getUTCMilliseconds(), 3)}` : base;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const frac = Math.floor((seconds - total) * 10);
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}.${frac}`;
}
