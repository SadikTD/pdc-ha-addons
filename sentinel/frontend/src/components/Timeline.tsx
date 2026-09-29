import { useCallback, useEffect, useRef, useState } from "react";
import { snapURL, type Label, type SentinelEvent, type Span } from "../lib/api";
import { LABELS, LABEL_ORDER } from "../lib/labels";
import { fmtTime, fmtTimeSec, HOUR, DAY, startOfDay } from "../lib/format";
import { usePreviewFrame } from "../lib/usePreview";

export type Lane = { id: string; label?: string; spans: Span[]; activity: [number, number][]; objects?: SentinelEvent[] };

type Props = {
  lanes: Lane[];
  start: number;
  end: number;
  now: number;
  cursor: number | null;
  onView: (start: number, end: number) => void;
  onSeek: (t: number, laneId: string) => void;
  selection?: { from: number; to: number } | null;
  onSelection?: (sel: { from: number; to: number }) => void;
  laneHeight?: number;
  // Which people/animal markers to draw (all when not given).
  showLabels?: Label[];
};

// The label a marker is drawn as: the first shown one of the event's.
const markerLabel = (e: SentinelEvent, show?: Label[]) => LABEL_ORDER.find((l) => e.labels?.includes(l) && (!show || show.includes(l)));

const MIN_RANGE = 2 * 60_000;
const MAX_RANGE = 7 * DAY;
const TICKS = [60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000, 30 * 60_000, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY];
const AXIS = 26;
const LABEL_W = 0;

export function Timeline({ lanes, start, end, now, cursor, onView, onSeek, selection, onSelection, laneHeight = 46, showLabels }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  const [hoverLane, setHoverLane] = useState<string | null>(null);
  const drag = useRef<{ x: number; start: number; end: number; moved: boolean; mode: "pan" | "selFrom" | "selTo" | "pinch"; dist?: number } | null>(null);
  const pointers = useRef(new Map<number, { x: number }>());
  const height = AXIS + lanes.length * (laneHeight + 6) + 4;

  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(200, e.contentRect.width)));
    if (wrap.current) ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  const range = end - start;
  const w = width - LABEL_W;
  const xOf = useCallback((t: number) => LABEL_W + ((t - start) / range) * w, [start, range, w]);
  const tOf = useCallback((x: number) => start + ((x - LABEL_W) / w) * range, [start, range, w]);

  // ---- draw ----
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = width * dpr;
    c.height = height * dpr;
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, height);
    g.font = "500 11px Inter Variable, system-ui, sans-serif";

    // ticks
    const step = TICKS.find((s) => (s / range) * w >= 80) ?? DAY;
    const off = localOffset(start);
    const first = Math.ceil((start + off) / step) * step - off;
    for (let t = first; t < end; t += step) {
      const x = xOf(t);
      const isDay = startOfDay(t) === t;
      g.fillStyle = isDay ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.06)";
      g.fillRect(Math.round(x), AXIS - 6, 1, height - AXIS + 6);
      g.fillStyle = isDay ? "#e2e8f0" : "#64748b";
      const label = isDay ? new Date(t).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }) : fmtTime(t);
      g.fillText(label, x + 4, 14);
    }

    lanes.forEach((lane, i) => {
      const y = AXIS + i * (laneHeight + 6);
      // track
      roundRect(g, 0, y, width, laneHeight, 8);
      g.fillStyle = "rgba(255,255,255,0.025)";
      g.fill();
      g.save();
      roundRect(g, 0, y, width, laneHeight, 8);
      g.clip();
      // recorded spans
      const grad = g.createLinearGradient(0, y, 0, y + laneHeight);
      grad.addColorStop(0, "rgba(139,92,246,0.42)");
      grad.addColorStop(1, "rgba(34,211,238,0.16)");
      for (const s of lane.spans) {
        if (s.e < start || s.s > end) continue;
        const x0 = Math.max(0, xOf(s.s));
        const x1 = Math.min(width, xOf(Math.min(s.e, now)));
        if (x1 - x0 < 0.5) continue;
        g.fillStyle = grad;
        g.fillRect(x0, y, Math.max(1, x1 - x0), laneHeight);
        g.fillStyle = "rgba(167,139,250,0.9)";
        g.fillRect(x0, y, Math.max(1, x1 - x0), 2);
      }
      // motion heatmap
      const bw = Math.max(1.5, (10_000 / range) * w);
      for (const [t, score] of lane.activity) {
        // Ignore sub-threshold flicker (noise, leaves) so real activity stands out.
        if (score < 0.3 || t < start - 60_000 || t > end) continue;
        const k = Math.min(1, Math.sqrt(score / 6));
        const h = Math.max(3, k * (laneHeight - 8));
        g.fillStyle = `rgba(251,191,36,${0.35 + 0.6 * k})`;
        g.fillRect(xOf(t), y + laneHeight - h, bw, h);
      }
      // future
      if (now < end) {
        const xn = Math.max(0, xOf(now));
        g.fillStyle = "rgba(5,7,11,0.65)";
        g.fillRect(xn, y, width - xn, laneHeight);
        g.strokeStyle = "rgba(255,255,255,0.04)";
        for (let x = xn - laneHeight; x < width; x += 8) {
          g.beginPath();
          g.moveTo(x, y + laneHeight);
          g.lineTo(x + laneHeight, y);
          g.stroke();
        }
      }
      // people and animals: a marker at the top of the lane
      for (const e of lane.objects ?? []) {
        const l = markerLabel(e, showLabels);
        const e1 = e.end || now;
        if (!l || e1 < start || e.start > end) continue;
        const x0 = xOf(e.start);
        const mw = Math.max(6, xOf(e1) - x0);
        g.fillStyle = "#0b0f17";
        roundRect(g, x0 - 1, y + laneHeight - 13, mw + 2, 10, 4);
        g.fill();
        g.fillStyle = LABELS[l].color;
        roundRect(g, x0, y + laneHeight - 12, mw, 8, 3);
        g.fill();
      }
      g.restore();
      if (lane.label) {
        g.fillStyle = "rgba(5,7,11,0.7)";
        const tw = g.measureText(lane.label).width;
        roundRect(g, 6, y + 6, tw + 12, 18, 6);
        g.fill();
        g.fillStyle = "#e2e8f0";
        g.fillText(lane.label, 12, y + 19);
      }
    });

    // selection
    if (selection) {
      const x0 = xOf(selection.from);
      const x1 = xOf(selection.to);
      g.fillStyle = "rgba(34,211,238,0.14)";
      g.fillRect(x0, AXIS - 4, x1 - x0, height - AXIS + 4);
      g.fillStyle = "#22d3ee";
      for (const x of [x0, x1]) {
        g.fillRect(x - 1, AXIS - 4, 2, height - AXIS + 4);
        roundRect(g, x - 5, AXIS + (height - AXIS) / 2 - 12, 10, 24, 4);
        g.fill();
      }
    }

    // now line
    if (now >= start && now <= end) {
      const x = xOf(now);
      g.fillStyle = "rgba(244,63,94,0.9)";
      g.fillRect(x - 0.5, AXIS - 4, 1.5, height - AXIS + 4);
    }

    // hover
    if (hover !== null && !drag.current?.moved) {
      const x = xOf(hover);
      g.fillStyle = "rgba(255,255,255,0.35)";
      g.fillRect(x, AXIS - 4, 1, height - AXIS + 4);
    }

    // playhead
    if (cursor !== null && cursor >= start && cursor <= end) {
      const x = xOf(cursor);
      g.shadowColor = "rgba(255,255,255,0.8)";
      g.shadowBlur = 8;
      g.fillStyle = "#fff";
      g.fillRect(x - 1, AXIS - 4, 2, height - AXIS + 4);
      g.shadowBlur = 0;
      g.beginPath();
      g.moveTo(x - 5, AXIS - 8);
      g.lineTo(x + 5, AXIS - 8);
      g.lineTo(x, AXIS - 2);
      g.fill();
    }
  }, [lanes, start, end, now, cursor, width, height, hover, selection, range, w, xOf, laneHeight, showLabels]);

  // ---- interaction ----
  const localX = (e: { clientX: number }) => e.clientX - (canvas.current?.getBoundingClientRect().left ?? 0);

  const clampView = (s: number, e: number) => {
    const r = Math.min(MAX_RANGE, Math.max(MIN_RANGE, e - s));
    const mid = (s + e) / 2;
    let ns = mid - r / 2;
    // Don't scroll far into the future.
    const maxEnd = now + Math.max(r * 0.15, 60_000);
    if (ns + r > maxEnd) ns = maxEnd - r;
    return [ns, ns + r] as const;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: localX(e) });
    const x = localX(e);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      drag.current = { x: (a.x + b.x) / 2, start, end, moved: true, mode: "pinch", dist: Math.abs(a.x - b.x) };
      return;
    }
    let mode: "pan" | "selFrom" | "selTo" = "pan";
    if (selection) {
      if (Math.abs(x - xOf(selection.from)) < 10) mode = "selFrom";
      else if (Math.abs(x - xOf(selection.to)) < 10) mode = "selTo";
    }
    drag.current = { x, start, end, moved: false, mode };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const x = localX(e);
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x });
    const d = drag.current;
    if (!d) {
      setHover(tOf(x));
      const y = e.clientY - (canvas.current?.getBoundingClientRect().top ?? 0);
      const li = Math.floor((y - AXIS) / (laneHeight + 6));
      setHoverLane(li >= 0 && li < lanes.length ? lanes[li].id : null);
      return;
    }
    if (d.mode === "pinch" && pointers.current.size === 2 && d.dist) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.max(20, Math.abs(a.x - b.x));
      const r = ((d.end - d.start) * d.dist) / dist;
      const anchor = d.start + ((d.x - LABEL_W) / w) * (d.end - d.start);
      const f = (d.x - LABEL_W) / w;
      onView(...clampView(anchor - f * r, anchor - f * r + r));
      return;
    }
    if (Math.abs(x - d.x) > 4) d.moved = true;
    if (!d.moved) return;
    if (d.mode === "selFrom" && selection && onSelection) {
      onSelection({ from: Math.min(tOf(x), selection.to - 1000), to: selection.to });
    } else if (d.mode === "selTo" && selection && onSelection) {
      onSelection({ from: selection.from, to: Math.max(tOf(x), selection.from + 1000) });
    } else {
      const dt = ((x - d.x) / w) * (d.end - d.start);
      onView(...clampView(d.start - dt, d.end - dt));
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    const d = drag.current;
    if (d && !d.moved && d.mode === "pan") {
      const x = localX(e);
      const y = e.clientY - (canvas.current?.getBoundingClientRect().top ?? 0);
      const lane = Math.max(0, Math.min(lanes.length - 1, Math.floor((y - AXIS) / (laneHeight + 6))));
      onSeek(tOf(x), lanes[lane]?.id ?? "");
    }
    if (pointers.current.size === 0) drag.current = null;
  };

  // Wheel zooms around the pointer (non-passive so the page doesn't scroll).
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const x = e.clientX - c.getBoundingClientRect().left;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const dt = (e.deltaX / w) * range;
        onView(...clampView(start + dt, end + dt));
        return;
      }
      const factor = Math.exp(e.deltaY * 0.0015);
      const anchor = tOf(x);
      const f = (x - LABEL_W) / w;
      const r = range * factor;
      onView(...clampView(anchor - f * r, anchor - f * r + r));
    };
    c.addEventListener("wheel", onWheel, { passive: false });
    return () => c.removeEventListener("wheel", onWheel);
  });

  const thumbT = hover !== null && hover < now && hoverLane ? hover : null;
  const thumb = usePreviewFrame(thumbT !== null ? hoverLane : null, thumbT);
  // A person/animal marker under the pointer shows its snapshot instead of the preview.
  const pad = (5 / w) * range;
  const hoverObj =
    thumbT !== null
      ? lanes.find((l) => l.id === hoverLane)?.objects?.find((e) => markerLabel(e, showLabels) && thumbT >= e.start - pad && thumbT <= (e.end || now) + pad)
      : undefined;

  return (
    <div ref={wrap} className="relative w-full select-none">
      <canvas
        ref={canvas}
        style={{ width, height, touchAction: "none" }}
        className="block cursor-grab active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => {
          setHover(null);
          setHoverLane(null);
        }}
      />
      {hover !== null && !drag.current && (
        <div
          className="pointer-events-none absolute -top-7 z-10 -translate-x-1/2 whitespace-nowrap rounded-md bg-white px-2 py-0.5 text-[11px] font-semibold text-ink-950 shadow-lg"
          style={{ left: Math.min(width - 40, Math.max(40, xOf(hover))) }}
        >
          {fmtTimeSec(hover)}
        </div>
      )}
      {thumbT !== null && !drag.current && (
        <div
          className="pointer-events-none absolute z-20 w-44 -translate-x-1/2 overflow-hidden rounded-xl border border-white/15 bg-ink-900 shadow-2xl shadow-black/60"
          style={{ left: Math.min(width - 88, Math.max(88, xOf(thumbT))), bottom: height + 30 }}
        >
          <div className="aspect-video bg-ink-800">
            {hoverObj?.snap ? (
              <img src={snapURL(hoverObj)} className="h-full w-full object-cover" />
            ) : thumb?.url ? (
              <img src={thumb.url} className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full items-center justify-center text-[10px] text-slate-500">{thumb ? "No preview" : "…"}</div>
            )}
          </div>
          {hoverObj && (
            <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] font-semibold text-white">
              <span className="size-2 rounded-full" style={{ background: LABELS[markerLabel(hoverObj, showLabels)!].color }} />
              {hoverObj.labels!.map((l) => LABELS[l].name).join(" + ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Local-time offset (ms to add to UTC), so ticks land on local hours and midnight.
function localOffset(t: number) {
  return -new Date(t).getTimezoneOffset() * 60_000;
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
