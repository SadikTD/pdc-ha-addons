import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { Lane } from "../components/Timeline";

// Loads coverage + motion activity for the visible window (with margin), debounced while
// the user drags, and refreshed periodically so the live edge keeps growing.
export function useTimeline(cams: { id: string; name: string }[], start: number, end: number) {
  const [lanes, setLanes] = useState<Lane[]>(() => cams.map((c) => ({ id: c.id, label: c.name, spans: [], activity: [], objects: [] })));
  const loaded = useRef<{ from: number; to: number; key: string; at: number } | null>(null);
  const key = cams.map((c) => c.id).join(",");

  useEffect(() => {
    let cancelled = false;
    const range = end - start;
    const fetchNow = async () => {
      const from = start - range * 0.5;
      const to = end + range * 0.5;
      // ~400 motion buckets across the view, never finer than the stored 10 s.
      const step = Math.max(10, Math.round(range / 1000 / 400));
      try {
        const next = await Promise.all(
          cams.map(async (c) => {
            const [spans, activity, objects] = await Promise.all([
              api.coverage(c.id, from, to),
              api.activity(c.id, from, to, step),
              // People and animals, shown as markers on the lane.
              api.events({ cameras: [c.id], from, to, labels: ["person", "cat", "dog"], limit: 2000 }).catch(() => []),
            ]);
            return { id: c.id, label: cams.length > 1 ? c.name : undefined, spans, activity, objects };
          }),
        );
        if (!cancelled) {
          setLanes(next);
          loaded.current = { from, to, key, at: Date.now() };
        }
      } catch {
        /* keep showing what we have */
      }
    };
    const l = loaded.current;
    const covered = l && l.key === key && start >= l.from && end <= l.to && Date.now() - l.at < 15_000;
    const t = window.setTimeout(fetchNow, covered ? 15_000 : 200);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, Math.round(start / 30_000), Math.round(end / 30_000), lanes]);

  return lanes;
}
