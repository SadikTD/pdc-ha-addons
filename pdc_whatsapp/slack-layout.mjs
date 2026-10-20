// Slack message layouts (Block Kit inside a coloured attachment). Duplicate
// alerts are built from the pitch itself; other PDC messages from their text.
import { alertValues } from './monitor/trello-monitor.mjs';

// Slack's brand colours: red, yellow, blue, green, and grey for the rest.
const COLOR = { duplicate: '#E01E5A', same_story: '#ECB22E', possible: '#36C5F0', ok: '#2EB67D', problem: '#ECB22E', other: '#9AA0A6' };
const HEADLINE = { duplicate: '🚨 Duplicate pitch', same_story: '⚠️ Similar story' };

export const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const isUrl = u => /^https?:\/\/\S{1,2900}$/.test(String(u || ''));
// A link in mrkdwn: <url|label>; the url can't carry | or >.
const link = (url, label) => (isUrl(url) ? `<${url.replace(/[|<>]/g, encodeURIComponent)}|${esc(label).replace(/\|/g, '¦')}>` : esc(label));
const section = text => ({ type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 3000) } });
const context = text => ({ type: 'context', elements: [{ type: 'mrkdwn', text: text.slice(0, 3000) }] });
// "Writer · Status · Today at 11:13 PM": Slack shows the time in each reader's
// own timezone; the Bangladesh time is the fallback. Day-only dates stay as is.
const when = (label, ts) => (Number.isInteger(ts) ? `<!date^${ts}^{date_short_pretty} at {time}|${esc(label)} BDT>` : esc(label));
const details = (writer, status, label, ts) => `${esc(writer)} · ${esc(status)} · ${when(label, ts)}`;
// Where a pitch lives: the Kanban board for board pitches (ids kb…), else the site's own platform.
export const platformOf = (cardId, site) => (/^kb\d/.test(String(cardId || '')) ? 'Kanban Board' : site.platform);
const button = (text, url, primary) => ({ type: 'button', text: { type: 'plain_text', text, emoji: true }, url, ...(primary ? { style: 'primary' } : {}) });

// A duplicate alert: headline, coloured bar by verdict, both pitches, the
// AI's reason, and buttons to open them.
export function slackAlert(job, qualifies, site) {
  const v = alertValues(job, qualifies, site);
  const headline = `${HEADLINE[v.verdict] || '💡 Possible overlap'} · ${site.label} (${platformOf(JSON.parse(job.card_json).id, site)})`;
  const blocks = [
    section(`*🆕 New pitch*\n${link(v.new_link, v.new_title)}\n${details(v.new_writer, v.new_status, v.new_date, v.new_ts)}`),
    section(`*📌 Already pitched*\n${link(v.old_link, v.old_title)}\n${details(v.old_writer, v.old_status, v.old_date, v.old_ts)}`),
  ];
  if (v.reason) blocks.push(context(`💬 ${esc(v.reason)}`));
  const buttons = [isUrl(v.new_link) && button('Open new pitch', v.new_link, true), isUrl(v.old_link) && button('Open earlier pitch', v.old_link)].filter(Boolean);
  if (buttons.length) blocks.push({ type: 'actions', elements: buttons });
  return {
    // Shown above the bar, and in notifications.
    text: `*${esc(headline)}*${v.confidence ? `  ·  ${esc(v.confidence)} match` : ''}`,
    attachments: [{ color: COLOR[v.verdict] || COLOR.possible, blocks }],
  };
}

// Any other message: first line as the headline, the rest in a coloured bar
// (green for recoveries, yellow for problems).
export function slackText(text) {
  const [first, ...rest] = String(text).trim().split('\n');
  const body = rest.join('\n').trim();
  const color = /^✅/.test(first) ? COLOR.ok : /^(⚠️|🚨|❌)/.test(first) ? COLOR.problem : COLOR.other;
  return { text: esc(first), ...(body ? { attachments: [{ color, blocks: [section(esc(body))] }] } : {}) };
}
