// Understands the ways people say a moment: "yesterday 3:15 pm", "3:15pm", "22:40",
// "mon 9am", "27 sep 14:05", "2026-09-27 15:15", "27/9 8pm", "10 min ago", "-2h", "noon".
// A time without a day means the most recent one (so at 1 am, "11pm" is last night).

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const UNITS: Record<string, number> = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 };

export function parseWhen(input: string, now = Date.now()): number | null {
  let s = ` ${input.trim().toLowerCase().replace(/[,]/g, " ").replace(/\s+/g, " ")} `;
  if (!s.trim()) return null;
  if (s.trim() === "now") return now;

  // "10 min ago", "-2h", "90 seconds ago"
  const rel = s.trim().match(/^(-\s*)?(\d+(?:\.\d+)?)\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?)(\s+ago)?$/);
  if (rel && (rel[1] || rel[4])) return now - parseFloat(rel[2]) * UNITS[rel[3][0]];

  s = s.replace(/\b(go to|jump to|at|on|the|of)\b/g, " ");
  let day: Date | null = null;
  let sameClock = false; // "yesterday" alone = this time yesterday
  let explicitDate = false;
  let weekday = false;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const take = (re: RegExp) => {
    const m = s.match(re);
    if (m) s = s.replace(m[0], " ");
    return m;
  };

  let m: RegExpMatchArray | null;
  if ((m = take(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/))) {
    day = new Date(+m[1], +m[2] - 1, +m[3]);
    explicitDate = true;
  } else if ((m = take(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/))) {
    // day/month, as written in most of the world
    const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : today.getFullYear();
    day = new Date(y, +m[2] - 1, +m[1]);
    explicitDate = true;
  } else if ((m = take(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)? (${MONTHS.join("|")})[a-z]*(?: (\\d{4}))?\\b`)))) {
    day = new Date(m[3] ? +m[3] : today.getFullYear(), MONTHS.indexOf(m[2]), +m[1]);
    explicitDate = true;
  } else if ((m = take(new RegExp(`\\b(${MONTHS.join("|")})[a-z]* (\\d{1,2})(?:st|nd|rd|th)?(?: (\\d{4}))?\\b`)))) {
    day = new Date(m[3] ? +m[3] : today.getFullYear(), MONTHS.indexOf(m[1]), +m[2]);
    explicitDate = true;
  }
  if (!day) {
    if (take(/\bday before yesterday\b/)) day = new Date(today.getTime() - 2 * 864e5);
    else if (take(/\byesterday\b|\blast night\b/)) day = new Date(today.getTime() - 864e5);
    else if (take(/\btoday\b|\btonight\b/)) day = new Date(today);
    else if ((m = take(new RegExp(`\\b(?:last )?(${DAYS.join("|")})[a-z]*\\b`)))) {
      const back = (today.getDay() - DAYS.indexOf(m[1]) + 7) % 7;
      day = new Date(today.getTime() - back * 864e5);
      weekday = true;
    }
    sameClock = !!day;
  }
  // A date in the future this year means last year's.
  if (explicitDate && day && day.getTime() > now && !/\d{4}/.test(input)) day.setFullYear(day.getFullYear() - 1);

  let h: number | null = null;
  let min = 0;
  let sec = 0;
  if (take(/\bnoon\b|\bmidday\b/)) h = 12;
  else if (take(/\bmidnight\b/)) h = 0;
  else if ((m = take(/\b(\d{1,2})(?:[:.](\d{2}))?(?:[:.](\d{2}))?\s*(am|pm|a|p)\b/))) {
    h = (+m[1] % 12) + (m[4].startsWith("p") ? 12 : 0);
    min = +(m[2] ?? 0);
    sec = +(m[3] ?? 0);
  } else if ((m = take(/\b(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?\b/))) {
    h = +m[1];
    min = +m[2];
    sec = +(m[3] ?? 0);
  } else if (day && (m = take(/\b(\d{1,2})\b/)) && +m[1] < 24) {
    h = +m[1];
  }
  if (s.trim()) return null; // words we didn't understand
  if (h === null && !day) return null;
  if (h !== null && (h > 23 || min > 59 || sec > 59)) return null;

  const d = new Date(day ?? today);
  if (h !== null) d.setHours(h, min, sec, 0);
  else if (sameClock) {
    const n = new Date(now);
    d.setHours(n.getHours(), n.getMinutes(), n.getSeconds(), 0);
  }
  let t = d.getTime();
  if (t > now + 60_000) {
    if (!day) t -= 864e5; // "11pm" at 1 am = last night
    else if (weekday) t -= 7 * 864e5;
  }
  return t;
}
