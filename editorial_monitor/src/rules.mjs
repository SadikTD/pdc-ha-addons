// The seven syndication guides, word for word. The add-on ships a copy (rules/*.txt, the
// Google Docs' own plain-text export) and can download them again on request, or every
// day when Settings > Rules > Refresh every day is on. A downloaded copy is kept in
// /data/rules and wins over the shipped one.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const GUIDES = [
  { key: 'quickref', title: 'Syndication quick reference', id: '1sh4TRRlI4yokgWoFYbf0cygA3V78Qkf-7Rg_TJ2-vxE' },
  { key: 'stories', title: 'Pitching guide', id: '1oAblAiV9gCp2wQ1x8hTzqWRZ4rwkUfAdUY5MzVfUNh4' },
  { key: 'headlines', title: 'Headline guide', id: '1LyY8zX_EAY7neLbpfHNSxPy41QllFngM70X5Vi1x-OI' },
  { key: 'format', title: 'Article format guide', id: '1QH00hiF9ZFbmBRWm4mPlO1p3PYITzFKzB-zWEWk8jIk' },
  { key: 'value', title: 'Content and accuracy guide', id: '174f9n-gKha2IMxWKcfdmAvcjZTB5D1GRAVDy195eVW8' },
  { key: 'interlinks', title: 'Interlinking guide', id: '1XRemzcE0wXvv9QJ7xA-oiIyYqJIq77hsXFGuacaiG0Y' },
  { key: 'wordpress', title: 'Embeds, images and WordPress guide', id: '1hWT5SkyhxKAk6HfJ0pm91Pa-nsCTTlYpRfrDy7leQQ8' },
];
export const guideTitle = key => GUIDES.find(g => g.key === key)?.title || key;
export const docUrl = key => `https://docs.google.com/document/d/${GUIDES.find(g => g.key === key)?.id}/edit`;

const SHIPPED = fileURLToPath(new URL('../rules/', import.meta.url));
const cleanDoc = t => String(t).replace(/^﻿/, '').replace(/\r/g, '');

export function createRules(dataDir) {
  const dir = join(dataDir, 'rules');
  const meta = { file: join(dir, 'meta.json') };
  let state = { refreshedAt: null, changed: [] };
  try { state = JSON.parse(readFileSync(meta.file, 'utf8')); } catch { /* never refreshed */ }
  const text = {};
  const load = () => {
    for (const g of GUIDES) {
      const own = join(dir, `${g.key}.txt`);
      text[g.key] = cleanDoc(readFileSync(existsSync(own) ? own : join(SHIPPED, `${g.key}.txt`), 'utf8'));
    }
  };
  load();

  // Downloads every guide; a guide that fails keeps its last copy. Returns the keys that changed.
  async function refresh(fetcher = fetch) {
    mkdirSync(dir, { recursive: true });
    const changed = [], failed = [];
    for (const g of GUIDES) {
      try {
        const res = await fetcher(`https://docs.google.com/document/d/${g.id}/export?format=txt`, { signal: AbortSignal.timeout(30000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const t = cleanDoc(await res.text());
        if (t.length < 200 || /<html/i.test(t.slice(0, 300))) throw new Error('not the document');
        if (t !== text[g.key]) { writeFileSync(join(dir, `${g.key}.txt`), t); changed.push(g.key); }
      } catch (e) { failed.push(`${g.title}: ${e.message}`); }
    }
    state = { refreshedAt: new Date().toISOString(), changed: changed.length ? changed : state.changed, changedAt: changed.length ? new Date().toISOString() : state.changedAt, failed };
    writeFileSync(meta.file, JSON.stringify(state));
    load();
    return { changed, failed };
  }

  return { text, refresh, status: () => ({ ...state, guides: GUIDES.map(g => ({ key: g.key, title: g.title, url: docUrl(g.key), chars: text[g.key].length })) }) };
}
