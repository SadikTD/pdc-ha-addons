// What a source or an embed says, from the platforms' public oEmbed endpoints (no keys):
// TikTok caption, X post text, YouTube title, Reddit title. Articles: the page's title,
// description and publish time. Everything here is best effort: a source that can't be
// read is just left out of the AI's context.
import { providerOf, stripTags, decode, clip } from './text.mjs';
import { postedFromUrl } from './checks.mjs';
import { UA } from './wp.mjs';

const OEMBED = {
  tiktok: u => `https://www.tiktok.com/oembed?url=${encodeURIComponent(u)}`,
  x: u => `https://publish.twitter.com/oembed?omit_script=1&url=${encodeURIComponent(u.replace('//x.com/', '//twitter.com/'))}`,
  youtube: u => `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(u)}`,
  reddit: u => `https://www.reddit.com/oembed?url=${encodeURIComponent(u)}`,
};

async function getText(fetcher, url, accept = 'application/json') {
  const res = await fetcher(url, { headers: { 'User-Agent': UA, Accept: accept }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// -> { url, provider, author, text, postedAt }
export async function readSource(url0, fetcher = fetch) {
  const provider = providerOf(url0);
  const info = { url: url0, provider, author: '', text: '', postedAt: null };
  let url = url0;
  try {
    // Short links (vm.tiktok.com/…, tiktok.com/t/…) lead to the video, whose id holds the post time.
    if (provider === 'tiktok' && !/\/(video|photo)\/\d/.test(url)) {
      const res = await fetcher(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
      url = res.headers.get('x-final-url') || res.url || url;
    }
  } catch { /* keep the short link */ }
  const id = postedFromUrl(url);
  if (id) info.postedAt = new Date(id).toISOString();
  if (url !== url0) info.resolved = url;
  try {
    const tt = provider === 'tiktok' && /(?:video\/|player\/v1\/|embed\/v2\/|\/v\/)(\d{15,22})/.exec(url);
    if (tt) {
      // TikTok's oEmbed no longer carries the caption (2026-11), so it comes from the
      // video page's own data; any @handle in the address finds the video.
      const page = await getText(fetcher, `https://www.tiktok.com/@x/video/${tt[1]}`, 'text/html');
      const data = JSON.parse((/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/.exec(page) || [])[1] || '{}');
      const item = data.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct || {};
      info.author = item.author?.uniqueId ? `@${item.author.uniqueId}` : '';
      info.text = String(item.desc || '');
      if (Number(item.createTime)) info.postedAt = new Date(Number(item.createTime) * 1000).toISOString();
    } else if (OEMBED[provider]) {
      const j = JSON.parse(await getText(fetcher, OEMBED[provider](url)));
      info.author = decode(j.author_name || j.author_unique_id || '');
      // X sends the post as HTML: its text is the first <p>.
      // Reddit sends no title field: the post title is the first link in its embed HTML.
      info.text = provider === 'x' ? stripTags((/<p[^>]*>([\s\S]*?)<\/p>/.exec(j.html || '') || [])[1] || '')
        : provider === 'reddit' ? decode((/<a\b[^>]*>([^<]+)<\/a>/.exec(j.html || '') || [])[1] || j.title || '')
          : decode(j.title || '');
    } else if (provider === 'web') {
      const html = (await getText(fetcher, url, 'text/html')).slice(0, 400000);
      const meta = name => decode((new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']*)`, 'i').exec(html) || new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${name}["']`, 'i').exec(html) || [])[1] || '');
      info.author = meta('og:site_name');
      if (/<title>\s*(Just a moment|Attention Required)/i.test(html)) throw new Error('blocked');
      info.text = [meta('og:title') || stripTags((/<title>([\s\S]*?)<\/title>/i.exec(html) || [])[1]), meta('og:description') || meta('description')].filter(Boolean).join(' - ');
      const when = meta('article:published_time') || (/"datePublished"\s*:\s*"([^"]+)"/.exec(html) || [])[1];
      if (when && Number.isFinite(Date.parse(when))) info.postedAt = new Date(when).toISOString();
      // The article itself, so the AI can check the headline against what the source really says
      // (the title and summary alone don't hold the details a headline claims).
      const body = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map(m => stripTags(m[1])).filter(p => p.length > 60 && !/cookie|subscribe|newsletter|sign up|log in|refresh the page/i.test(p));
      if (body.length) info.text = `${info.text}\n${body.join('\n')}`;
    }
  } catch { /* unreadable: no text */ }
  info.text = clip(info.text, 8000);
  return info;
}

// The text of each embed in an article, for the cursing check and the AI.
export async function readEmbeds(embeds, fetcher = fetch) {
  const out = [];
  for (const e of embeds.slice(0, 6)) {
    if (!e.url || !OEMBED[e.provider]) { if (e.text) out.push({ url: e.url, provider: e.provider, text: clip(e.text, 1500) }); continue; }
    const s = await readSource(e.url, fetcher);
    out.push({ url: e.url, provider: e.provider, text: s.text || e.text, author: s.author });
  }
  return out;
}
