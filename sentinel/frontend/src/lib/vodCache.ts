import Hls, { LoadStats, type Loader, type LoaderCallbacks, type LoaderConfiguration, type LoaderContext, type LoaderStats, type HlsConfig } from "hls.js";
import { vodURL } from "./api";

// Recordings never change once written, so every byte of them fetched once is kept (in
// memory, least recently used out first) and never fetched again: going back to an event,
// seeking back, or reopening a moment is instant. On top of that the player warms what is
// likely next (the next and previous event in a list), so stepping through events starts
// at once even on a slow connection.

const MAX_BYTES = 80 * 1024 * 1024;
const PLAYLIST_TTL = 60_000;

type Entry = { data: ArrayBuffer | string; size: number; at: number; playlist: boolean };
const store = new Map<string, Entry>(); // insertion order = LRU order
let bytes = 0;
const inflight = new Map<string, Promise<void>>();

// Recent downloads, to tell how much the connection carries (kbit/s) when it is busy.
const recent: { start: number; end: number; bytes: number }[] = [];
function noteDownload(stats: LoaderStats) {
  const now = performance.now();
  recent.push({ start: stats.loading.start || now, end: now, bytes: stats.loaded });
  while (recent.length && recent[0].end < now - 10_000) recent.shift();
}

/** What the connection delivered lately (kbit/s), or 0 when there is too little to tell. */
export function linkRate() {
  const now = performance.now();
  const win = recent.filter((r) => r.end > now - 8000);
  if (win.length < 2) return 0;
  const since = Math.max(now - 8000, Math.min(...win.map((r) => r.start)));
  const bytes = win.reduce((n, r) => n + r.bytes, 0);
  return now - since > 1000 ? (bytes * 8) / (now - since) : 0;
}

const abs = (u: string) => new URL(u, document.baseURI).href;
const keyOf = (url: string, start?: number, end?: number) => `${url}|${start ?? ""}-${end ?? ""}`;

function get(key: string): Entry | null {
  const e = store.get(key);
  if (!e) return null;
  if (e.playlist && Date.now() - e.at > PLAYLIST_TTL) {
    drop(key);
    return null;
  }
  store.delete(key);
  store.set(key, e);
  return e;
}

function drop(key: string) {
  const e = store.get(key);
  if (!e) return;
  store.delete(key);
  bytes -= e.size;
}

function put(key: string, data: ArrayBuffer | string, playlist: boolean) {
  drop(key);
  const size = typeof data === "string" ? data.length * 2 : data.byteLength;
  if (size > MAX_BYTES / 4) return;
  store.set(key, { data, size, at: Date.now(), playlist });
  bytes += size;
  for (const [k] of store) {
    if (bytes <= MAX_BYTES) break;
    drop(k);
  }
}

// A playlist whose window ended a while ago won't change (for a minute, anyway: retention
// may remove files); one reaching up to now still grows.
function settled(url: string) {
  const to = Number(new URL(url).searchParams.get("to"));
  return to > 0 && to < Date.now() - 30_000;
}

// Which requests are recordings: settled playlists (for a little while) and byte ranges
// of recording files (for good).
function cacheable(ctx: LoaderContext): { key: string; playlist: boolean } | null {
  if (ctx.url.includes("/api/seg/") && ctx.rangeEnd) return { key: keyOf(ctx.url, ctx.rangeStart, ctx.rangeEnd), playlist: false };
  if (ctx.url.includes("/api/vod.m3u8") && settled(ctx.url)) return { key: keyOf(ctx.url), playlist: true };
  return null;
}

/** The window of footage a player loads to play from time t (shared so warm-ups match). */
export function vodWindow(camera: string, t: number) {
  const from = t - 60_000;
  // Rounded up to the minute so the same moment asks for the same playlist for a while.
  const to = Math.min(Math.ceil((Date.now() + 60_000) / 60_000) * 60_000, t + 30 * 60_000);
  return { from, to, url: vodURL(camera, from, to) };
}

// hls.js loader that answers from the cache when it can and fills it otherwise.
class CachingLoader implements Loader<LoaderContext> {
  private inner: Loader<LoaderContext>;
  private own: LoaderStats | null = null;
  private timer = 0;
  private dead = false;
  context: LoaderContext | null = null;

  constructor(config: HlsConfig) {
    const Base = Hls.DefaultConfig.loader;
    this.inner = new Base(config);
  }

  get stats(): LoaderStats {
    return this.own ?? this.inner.stats;
  }

  load(context: LoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>) {
    this.context = context;
    const c = cacheable(context);
    const serve = (e: Entry) => {
      const s = new LoadStats();
      const now = performance.now();
      s.loading.start = s.loading.first = s.loading.end = now;
      s.loaded = s.total = typeof e.data === "string" ? e.data.length : e.data.byteLength;
      this.own = s;
      // A copy: the player hands fragment buffers to its worker, which empties them.
      const data = typeof e.data === "string" ? e.data : e.data.slice(0);
      this.timer = window.setTimeout(() => !this.dead && callbacks.onSuccess({ url: context.url, data }, s, context, null), 0);
    };
    const fetchIt = () => {
      if (this.dead) return;
      this.own = null;
      this.inner.load(context, config, {
        ...callbacks,
        onSuccess: (res, stats, ctx, details) => {
          if (c && !c.playlist) noteDownload(stats);
          if (c && res.data && (typeof res.data === "string" || res.data instanceof ArrayBuffer)) {
            put(c.key, typeof res.data === "string" ? res.data : res.data.slice(0), c.playlist);
          }
          callbacks.onSuccess(res, stats, ctx, details);
        },
      });
    };
    const hit = c && get(c.key);
    if (hit) return serve(hit);
    // Already on its way (a warm-up): wait for it rather than download it twice.
    const pending = c && inflight.get(c.key);
    if (pending) {
      pending.then(() => {
        const e = get(c.key);
        if (e) serve(e);
        else fetchIt();
      });
      return;
    }
    fetchIt();
  }

  abort() {
    window.clearTimeout(this.timer);
    this.inner.abort();
  }

  destroy() {
    this.dead = true;
    window.clearTimeout(this.timer);
    this.inner.destroy();
  }

  getCacheAge() {
    return null;
  }

  getResponseHeader(name: string) {
    return this.inner.getResponseHeader?.(name) ?? null;
  }
}

export const cachingLoader = CachingLoader as unknown as HlsConfig["loader"];

// ---- warm-ups ----

type Ref = { uri: string; start: number; end: number };

// The init section and the first fragments to play from time t, from a playlist.
function refsAt(text: string, t: number, count: number): Ref[] {
  let map: Ref | null = null;
  let pdt = 0;
  let inFile = 0;
  let dur = 0;
  let range: { start: number; end: number } | null = null;
  const out: Ref[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("#EXT-X-MAP:")) {
      const uri = /URI="([^"]+)"/.exec(line)?.[1];
      const br = /BYTERANGE="(\d+)@(\d+)"/.exec(line);
      map = uri && br ? { uri, start: +br[2], end: +br[2] + +br[1] } : null;
    } else if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
      pdt = Date.parse(line.slice(25));
      inFile = 0;
    } else if (line.startsWith("#EXTINF:")) {
      dur = parseFloat(line.slice(8));
    } else if (line.startsWith("#EXT-X-BYTERANGE:")) {
      const [n, o] = line.slice(17).split("@").map(Number);
      range = { start: o, end: o + n };
    } else if (line && !line.startsWith("#") && range) {
      const fEnd = pdt + (inFile + dur) * 1000;
      inFile += dur;
      if (out.length || fEnd > t) {
        if (!out.length && map) out.push(map);
        out.push({ uri: line, ...range });
        if (out.length > count) break;
      }
      range = null;
    }
  }
  return out;
}

async function fetchRange(url: string, start: number, end: number) {
  const key = keyOf(url, start, end);
  if (get(key) || inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const res = await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` }, priority: "low" } as RequestInit);
      if (res.status === 206 || res.status === 200) {
        const buf = await res.arrayBuffer();
        if (buf.byteLength === end - start) put(key, buf, false);
      }
    } catch {
      // Only a warm-up.
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

let warmChain: Promise<unknown> = Promise.resolve();
let warmGen = 0;

/**
 * Fetch, in the background and one at a time, what it takes to start playing each of
 * these moments at once. A newer call replaces the older wishes.
 */
export function warmMoments(moments: { camera: string; t: number }[]) {
  const gen = ++warmGen;
  warmChain = warmChain.then(async () => {
    for (const m of moments) {
      if (gen !== warmGen) return;
      if (m.t > Date.now() - 20_000) continue;
      const w = vodWindow(m.camera, m.t);
      const url = abs(w.url);
      let text = get(keyOf(url))?.data;
      if (typeof text !== "string") {
        try {
          const res = await fetch(url, { cache: "no-store", priority: "low" } as RequestInit);
          if (!res.ok) continue;
          text = await res.text();
          if (settled(url)) put(keyOf(url), text, true);
        } catch {
          continue;
        }
      }
      // The init section and two fragments: enough to start and keep going while the
      // player catches up with the rest.
      for (const r of refsAt(text, m.t, 2)) {
        if (gen !== warmGen) return;
        await fetchRange(new URL(r.uri, url).href, r.start, r.end);
      }
    }
  });
}
