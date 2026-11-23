// Reads a published post from the site's public WordPress API (no login). A scheduled
// post isn't public yet: the API answers 401/404 until it goes live, so "not live" is a
// normal answer, not an error.
import { stripTags, decode, hostOf } from './text.mjs';

// A browser user agent: the sites' Cloudflare blocks generic clients.
export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const get = (fetcher, url) => fetcher(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, redirect: 'follow', signal: AbortSignal.timeout(30000) });

// The post id from an edit link (…/wp-admin/post.php?post=123&action=edit) and the slug from a live link.
export const postIdFrom = editUrl => (/[?&]post=(\d+)/.exec(String(editUrl || '')) || [])[1] || null;
export const slugFrom = url => { try { const p = new URL(url).pathname.split('/').filter(Boolean); return p.length ? p[p.length - 1] : null; } catch { return null; } };

const FIELDS = 'id,status,date_gmt,link,slug,title,content,excerpt,featured_media,categories,tags,yoast_head_json.title,yoast_head_json.description,_links,_embedded';

// Without a link (writers forget, and the board feed didn't send links before the 2026-11-23
// patch), the post is found by its headline: a published post whose title has the card's
// words (at least 90% of them) and that went live after the card was made.
const titleWords = t => decode(stripTags(t)).toLowerCase().replace(/[’']/g, '').split(/[^a-z0-9]+/).filter(Boolean);
export function sameTitle(a, b) {
  const x = titleWords(a), y = titleWords(b);
  if (!x.length || !y.length) return false;
  if (x.join(' ') === y.join(' ')) return true;
  const sy = new Set(y), common = x.filter(w => sy.has(w)).length;
  return common / Math.max(x.length, y.length) >= 0.9;
}
async function findByTitle(site, title, since, fetcher) {
  const q = titleWords(title).slice(0, 10).join(' ');
  const res = await get(fetcher, `${site.wp}/wp-json/wp/v2/posts?search=${encodeURIComponent(q)}&per_page=10&_fields=id,title,date_gmt`);
  if (!res.ok) throw new Error(`${site.label} WordPress answered ${res.status}`);
  const list = await res.json();
  return (Array.isArray(list) ? list : []).find(p => sameTitle(p.title?.rendered, title) && (!since || Date.parse(`${p.date_gmt}Z`) >= since - 86400000)) || null;
}

// -> { live: true, post } | { live: false, reason }
export async function fetchPost(site, { editUrl, publishUrl, title, since }, fetcher = fetch) {
  if (!editUrl && !publishUrl && title) {
    const hit = await findByTitle(site, title, since, fetcher);
    if (!hit) return { live: false, reason: 'Not published yet (looked up by headline)' };
    editUrl = `${site.wp}/wp-admin/post.php?post=${hit.id}&action=edit`;
  }
  const id = postIdFrom(editUrl);
  const wrong = [editUrl, publishUrl].filter(Boolean).find(u => hostOf(u) && hostOf(u) !== hostOf(site.wp));
  if (wrong) return { live: false, reason: `Link is for another site (${hostOf(wrong)})` };
  let raw = null;
  if (id) {
    const res = await get(fetcher, `${site.wp}/wp-json/wp/v2/posts/${id}?_embed=wp:featuredmedia,wp:term&_fields=${FIELDS}`);
    if (res.status === 401 || res.status === 403 && !(await isChallenge(res)) || res.status === 404) return { live: false, reason: 'Not published yet' };
    if (!res.ok) throw new Error(`${site.label} WordPress answered ${res.status}`);
    raw = await res.json();
  } else if (slugFrom(publishUrl)) {
    const res = await get(fetcher, `${site.wp}/wp-json/wp/v2/posts?slug=${encodeURIComponent(slugFrom(publishUrl))}&_embed=wp:featuredmedia,wp:term&_fields=${FIELDS}`);
    if (!res.ok) throw new Error(`${site.label} WordPress answered ${res.status}`);
    const list = await res.json();
    if (!Array.isArray(list) || !list.length) return { live: false, reason: 'Not published yet' };
    raw = list[0];
  } else return { live: false, reason: 'No edit or publish link on the card' };
  if (raw.status && raw.status !== 'publish') return { live: false, reason: 'Not published yet' };
  const post = normalize(raw);
  if (post.tagIds.length) {
    try {
      const res = await get(fetcher, `${site.wp}/wp-json/wp/v2/tags?include=${post.tagIds.join(',')}&per_page=50&_fields=id,name,count`);
      if (res.ok) { const counts = new Map((await res.json()).map(t => [t.id, t.count])); post.tags = post.tags.map(t => ({ ...t, count: counts.get(t.id) ?? null })); }
    } catch { /* counts are a nice-to-have */ }
  }
  return { live: true, post };
}
const isChallenge = async res => /cloudflare|just a moment/i.test(await res.clone().text().catch(() => ''));

export function normalize(p) {
  const media = (p._embedded?.['wp:featuredmedia'] || [])[0];
  const terms = (p._embedded?.['wp:term'] || []).flat();
  const md = media?.media_details || {};
  const image = p.featured_media && media && !media.code ? {
    url: media.source_url, file: md.file || media.source_url, width: md.width ?? null, height: md.height ?? null,
    title: stripTags(media.title?.rendered), caption: media.caption?.rendered || '',
    preview: md.sizes?.large?.source_url || md.sizes?.medium?.source_url || media.source_url,
  } : null;
  const cats = terms.filter(t => t.taxonomy === 'category');
  const first = (() => { try { return new URL(p.link).pathname.split('/').filter(Boolean)[0]; } catch { return null; } })();
  const primary = cats.find(c => c.slug === first);
  return {
    id: p.id, link: p.link, date: p.date_gmt ? `${p.date_gmt}Z` : null,
    title: stripTags(p.title?.rendered), content: p.content?.rendered || '', excerpt: p.excerpt?.rendered || '',
    seoTitle: decode(p.yoast_head_json?.title || ''), metaDescription: decode(p.yoast_head_json?.description || ''),
    image, tagIds: p.tags || [],
    tags: terms.filter(t => t.taxonomy === 'post_tag').map(t => ({ id: t.id, name: decode(t.name), count: null })),
    categories: cats.map(c => decode(c.name)), primaryCategory: primary ? decode(primary.name) : null,
  };
}

// What each interlink points to (headline and summary of the linked story), so the AI can
// judge U-turns and crime links from the story itself rather than its address.
export async function linkTargets(site, urls, fetcher = fetch) {
  const out = [];
  for (const url of [...new Set(urls)].slice(0, 6)) {
    const slug = slugFrom(url);
    if (!slug) continue;
    try {
      const res = await get(fetcher, `${site.wp}/wp-json/wp/v2/posts?slug=${encodeURIComponent(slug)}&_fields=title,excerpt`);
      const p = res.ok ? (await res.json())[0] : null;
      if (p) out.push({ url, title: stripTags(p.title?.rendered), summary: stripTags(p.excerpt?.rendered).slice(0, 300) });
    } catch { /* unreadable: the AI sees the address only */ }
  }
  return out;
}
