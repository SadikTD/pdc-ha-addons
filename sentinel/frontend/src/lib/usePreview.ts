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
  const want = useRef<{ cam: string; t: number } | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    want.current = cam && t !== null ? { cam, t } : null;
    if (!want.current) return;
    const pump = async () => {
      if (busy.current || !want.current) return;
      const target = want.current;
      busy.current = true;
      const url = await load(target.cam, target.t);
      busy.current = false;
      const next = want.current;
      // Only show it if it's still what's wanted (the camera may have changed meanwhile).
      if (next?.cam === target.cam) setFrame({ url, t: target.t });
      if (next && previewKey(next.cam, next.t) !== previewKey(target.cam, target.t)) pump();
    };
    pump();
  }, [cam, t]);

  return t === null ? null : frame;
}

// Warm-up requests wait in a queue and run two at a time, so they never hold up what the
// user is waiting for (the video itself, or the frame under their finger): browsers allow
// only ~6 connections per server.
const queue: { cam: string; t: number }[] = [];
let running = 0;
function drain() {
  while (running < 2 && queue.length) {
    const { cam, t } = queue.shift()!;
    if (cache.has(previewKey(cam, t))) continue;
    running++;
    load(cam, t).finally(() => {
      running--;
      drain();
    });
  }
}

// Warm the cache around a time (e.g. when the timeline opens) so the first drag is instant.
export function prefetchPreviews(cam: string, center: number, spanMs: number, count = 24) {
  const step = Math.max(STEP, spanMs / count);
  // Drop older warm-ups for this camera: the view has moved on.
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].cam === cam) queue.splice(i, 1);
  // Nearest to the playhead first.
  const offsets = Array.from({ length: count + 1 }, (_, i) => i - count / 2).sort((a, b) => Math.abs(a) - Math.abs(b));
  for (const i of offsets) {
    const t = center + i * step;
    if (t < Date.now() && !cache.has(previewKey(cam, t))) queue.push({ cam, t });
  }
  drain();
}
