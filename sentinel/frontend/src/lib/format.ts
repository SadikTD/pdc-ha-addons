export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const timeSecFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });

export const fmtTime = (ms: number) => timeFmt.format(ms);
export const fmtTimeSec = (ms: number) => timeSecFmt.format(ms);

export function fmtDay(ms: number) {
  const d = startOfDay(ms);
  const today = startOfDay(Date.now());
  if (d === today) return "Today";
  if (d === today - DAY) return "Yesterday";
  return dayFmt.format(ms);
}

export function startOfDay(ms: number) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function fmtBytes(b: number) {
  if (b < 1e6) return `${(b / 1e3).toFixed(0)} KB`;
  if (b < 1e9) return `${(b / 1e6).toFixed(0)} MB`;
  if (b < 1e12) return `${(b / 1e9).toFixed(b < 1e10 ? 1 : 0)} GB`;
  return `${(b / 1e12).toFixed(2)} TB`;
}

export function fmtDuration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60 ? `${s % 60}s` : ""}`.trim();
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60 ? `${m % 60}m` : ""}`.trim();
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function fmtAgo(ms: number, now = Date.now()) {
  const d = now - ms;
  if (d < 5_000) return "just now";
  return `${fmtDuration(d)} ago`;
}

export const fmtBitrate = (kbps: number) => (kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${Math.round(kbps)} kbps`);
