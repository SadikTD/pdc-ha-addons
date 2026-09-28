import { useEffect, useRef, useState } from "react";

// Preview frames exist every 2 s. While scrubbing we ask for many times per second, so:
// quantize, cache (LRU of object URLs, including misses), keep one request in flight and
// always fetch the most recent wish next — the image never lags far behind the finger.

const STEP = 2000;
const MAX = 800;
const cache = new Map<string, string | null>(); // key -> object URL, or null = no frame

function remember(key: string, url: string | null) {
  cache.set(key, url);
  if (cache.size > MAX) {
    const [k, v] = cache.entries().next().value as [string, string | null];
    cache.delete(k);
    if (v) URL.revokeObjectURL(v);
  }
}

export const previewKey = (cam: string, t: number) => `${cam}:${Math.round(t / STEP) * STEP}`;

async function load(cam: string, t: number): Promise<string | null> {
  const key = previewKey(cam, t);
  if (cache.has(key)) {
    const v = cache.get(key)!;
    cache.delete(key); // refresh LRU position
    cache.set(key, v);
    return v;
  }
  const q = Math.round(t / STEP) * STEP;
  try {
    const res = await fetch(`api/preview/${cam}/${q}`);
    const url = res.ok ? URL.createObjectURL(await res.blob()) : null;
    // Don't cache misses for the last minute: frames for "now" are still arriving.
    if (url || Date.now() - q > 60_000) remember(key, url);
    return url;
  } catch {
    return null;
  }
}

export function usePreviewFrame(cam: string | null, t: number | null) {
  const [frame, setFrame] = useState<{ url: string | null; t: number } | null>(null);
  const want = useRef<number | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    want.current = t;
    if (!cam || t === null) return;
    const pump = async () => {
      if (busy.current || want.current === null) return;
      const target = want.current;
      busy.current = true;
      const url = await load(cam, target);
      busy.current = false;
      setFrame({ url, t: target });
      if (want.current !== null && previewKey(cam, want.current) !== previewKey(cam, target)) pump();
    };
    pump();
  }, [cam, t]);

  return t === null ? null : frame;
}

// Warm the cache around a time (e.g. when the timeline opens) so the first drag is instant.
export function prefetchPreviews(cam: string, center: number, spanMs: number, count = 24) {
  const step = Math.max(STEP, spanMs / count);
  for (let i = -count / 2; i <= count / 2; i++) {
    const t = center + i * step;
    if (t < Date.now() && !cache.has(previewKey(cam, t))) load(cam, t);
  }
}
