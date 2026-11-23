// WhatsApp messages, sent through the PDC WhatsApp Bridge (POST /send). The bridge isn't
// published on the host, so it's found on the Supervisor network like Net Monitor does.
// Each message has an idempotency key, so a retry never sends it twice.
import { RULES } from './catalog.mjs';
import { guideTitle } from './rules.mjs';
import { clip } from './text.mjs';
import { siteById } from './sites.mjs';

const label = id => RULES[id]?.title || id;
const SEV = { problem: 'Problem', check: 'Check' };

export function checkMessage(card, check, findings, extra = {}) {
  const site = siteById(card.site)?.label || card.site;
  const problems = findings.filter(f => f.severity === 'problem').length, checks = findings.length - problems;
  const what = check.kind === 'pitch' ? 'Pitch' : 'Published article';
  const counts = [problems && `${problems} problem${problems > 1 ? 's' : ''}`, checks && `${checks} to check`].filter(Boolean).join(', ');
  const lines = [`*${what} needs a look: ${counts}*`, `${site} | ${card.writer || 'Unknown writer'}`, `"${clip(card.title, 200)}"`, ''];
  findings.slice(0, 10).forEach((f, i) => {
    const r = RULES[f.rule];
    lines.push(`${i + 1}. *${SEV[f.severity]}: ${label(f.rule)}*${f.by === 'ai' ? ' (AI)' : ''}`);
    if (f.evidence) lines.push(`Found: ${clip(f.evidence, 220)}`);
    if (f.note) lines.push(f.note);
    if (r) lines.push(`_${guideTitle(r.guide)}: "${clip(r.quote, 200)}"_`);
    lines.push('');
  });
  if (findings.length > 10) lines.push(`...and ${findings.length - 10} more on the dashboard.`, '');
  lines.push(`Card: ${card.url}`);
  if (extra.link) lines.push(`Article: ${extra.link}`);
  else if (card.edit_url) lines.push(`Edit link: ${card.edit_url}`);
  return clip(lines.join('\n'), 4000);
}

export function noSourcesMessage(card, minutes) {
  const site = siteById(card.site)?.label || card.site;
  return [`*No sources after ${minutes} minutes*`, `${site} | ${card.writer || 'Unknown writer'}`, `"${clip(card.title, 200)}"`, '',
    'The card has no source links yet, so the pitch can\'t be checked.', `Card: ${card.url}`].join('\n');
}

export function createBridge({ settings, supervisor = null, fetcher = fetch }) {
  let found = null;
  async function url() {
    const s = settings.get();
    if (s.bridgeUrl) return s.bridgeUrl;
    if (found) return found;
    if (!supervisor) return null;
    try {
      const own = await supervisor('/addons/self/info');
      const slug = String(own?.slug || '').replace(/editorial_monitor$/, 'pdc_whatsapp');
      const info = slug ? await supervisor(`/addons/${slug}/info`) : null;
      if (info?.ip_address) found = `http://${info.ip_address}:8787`;
    } catch { /* not found yet */ }
    return found;
  }
  async function send(text, idempotencyKey) {
    const s = settings.get();
    if (!s.bridgeToken || !s.whatsappTo) throw new Error('WhatsApp isn\'t set up (Settings > WhatsApp)');
    const base = await url();
    if (!base) throw new Error('Couldn\'t find the PDC WhatsApp Bridge add-on; set its address in Settings');
    const res = await fetcher(`${base}/send`, { method: 'POST', signal: AbortSignal.timeout(40000),
      headers: { Authorization: `Bearer ${s.bridgeToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: s.whatsappTo, text, idempotencyKey }) });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) throw new Error('The bridge rejected the token (401)');
      throw new Error(`Bridge answered ${res.status}${body?.error ? `: ${clip(body.error, 120)}` : ''}`);
    }
    return true;
  }
  return { send, url, reset: () => { found = null; } };
}
