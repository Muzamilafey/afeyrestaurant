/** Milliseconds to add to a UTC instant to get wall-clock time in `tz`. */
export function tzOffset(date: Date, tz: string) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date);
  const g = (t: string) => Number(p.find((x) => x.type === t)!.value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(date.getTime() / 1000) * 1000;
}

/** Midnight of the day containing `date`, in `tz`. */
export function startOfDay(date: Date, tz: string) {
  const off = tzOffset(date, tz);
  const local = new Date(date.getTime() + off);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - off);
}

/** The business day "YYYY-MM-DD" in `tz` as [start, end) instants. */
export function dayRange(day: string, tz: string) {
  const [y, m, d] = day.split('-').map(Number);
  const start = startOfDay(new Date(Date.UTC(y, m - 1, d, 12)), tz);
  const end = startOfDay(new Date(start.getTime() + 36 * 3600_000), tz);
  return { start, end };
}

/** Today's date "YYYY-MM-DD" in `tz`. */
export function localDate(tz: string, d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
