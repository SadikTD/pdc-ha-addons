import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import type { SentinelEvent, Span } from "../lib/api";
import { fmtTime, fmtTimeSec, HOUR, DAY, startOfDay } from "../lib/format";
import { usePreviewFrame } from "../lib/usePreview";
import { LABELS, mainLabel } from "../lib/labels";
import { snapURL } from "../lib/api";

// A fixed playhead in the middle; the timeline slides underneath it (like UniFi Protect /
// Frigate). Drag or flick to scrub (with momentum), click to jump, scroll/pinch to zoom.

type Props = {
  camera: string;
  spans: Span[];
  activity: [number, number][];
  events: SentinelEvent[];
  now: number;
  center: number;
  range: number;
  live: boolean;
  selection?: { from: number; to: number } | null;
  onSelection?: (s: { from: number; to: number }) => void;
  onScrubStart: () => void;
  onScrub: (t: number) => void;
  onScrubEnd: (t: number) => void;
  onRange: (r: number) => void;
  // Before this time only motion footage is kept, so gaps there aren't missing footage.
  fullFrom?: number;
};

export const MIN_RANGE = 60_000;
export const MAX_RANGE = 2 * DAY;
const TICKS = [10_000, 30_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000, 30 * 60_000, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY];
const AXIS = 22;
const EV_Y = AXIS + 4;
const EV_H = 12;
const TRACK_Y = EV_Y + EV_H + 6;
const TRACK_H = 46;
const HEIGHT = TRACK_Y + TRACK_H + 6;

export function Scrubber(p: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [onEdge, setOnEdge] = useState(false);
  const props = useRef(p);
  props.current = p;
  const gesture = useRef<{ x: number; c0: number; moved: boolean; samples: { x: number; at: number }[]; pinch?: { d0: number; r0: number }; edge?: "from" | "to" } | null>(null);
  const pointers = useRef(new Map<number, number>());
  const anim = useRef(0);
  const wheelEnd = useRef(0);
  const scrubbing = useRef(false);

  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, e.contentRect.width)));
    if (wrap.current) ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);
  useEffect(() => () => cancelAnimationFrame(anim.current), []);

  const { center, range, now } = p;
  const start = center - range / 2;
  const end = center + range / 2;
  const xOf = (t: number) => ((t - start) / range) * width;
  const tOf = (x: number) => start + (x / width) * range;
  const clampT = (t: number) => Math.min(props.current.now, t);

  // ---- draw ----
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = width * dpr;
    c.height = HEIGHT * dpr;
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, HEIGHT);
    g.font = "500 10.5px Inter Variable, system-ui, sans-serif";
    g.textBaseline = "middle";

    // track background
    rr(g, 0, TRACK_Y, width, TRACK_H, 10);
    g.fillStyle = "rgba(255,255,255,0.03)";
    g.fill();

    // ticks
    const step = TICKS.find((s) => (s / range) * width >= 90) ?? DAY;
    const minor = TICKS[Math.max(0, TICKS.indexOf(step) - 2)] ?? step;
    const off = -new Date(start).getTimezoneOffset() * 60_000;
    for (let t = Math.ceil((start + off) / minor) * minor - off; t < end; t += minor) {
      const x = Math.round(xOf(t)) + 0.5;
      const major = Math.abs(((t + off) % step + step) % step) < 1;
      g.fillStyle = major ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.04)";
      g.fillRect(x, major ? AXIS - 6 : AXIS - 3, 1, major ? HEIGHT - AXIS + 6 : 5);
      if (major) {
        const midnight = startOfDay(t) === t;
        g.fillStyle = midnight ? "#e2e8f0" : "#64748b";
        const label = midnight ? new Date(t).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) : step < 60_000 ? fmtTimeSec(t) : fmtTime(t);
        g.fillText(label, x + 4, 9);
      }
    }

    g.save();
    rr(g, 0, TRACK_Y, width, TRACK_H, 10);
    g.clip();
    // gaps (no recording) since the first recording: faint red so missing footage stands out
    const first = p.spans[0]?.s;
    if (first !== undefined) {
      let cursor = Math.max(first, start, p.fullFrom ?? 0);
      const gapTo = Math.min(end, now);
      g.fillStyle = "rgba(244,63,94,0.10)";
      for (const s of p.spans) {
        if (s.s > cursor) g.fillRect(xOf(cursor), TRACK_Y, xOf(Math.min(s.s, gapTo)) - xOf(cursor), TRACK_H);
        cursor = Math.max(cursor, s.e);
        if (cursor >= gapTo) break;
      }
      if (cursor < gapTo) g.fillRect(xOf(cursor), TRACK_Y, xOf(gapTo) - xOf(cursor), TRACK_H);
    }
    // recorded
    const grad = g.createLinearGradient(0, TRACK_Y, 0, TRACK_Y + TRACK_H);
    grad.addColorStop(0, "rgba(139,92,246,0.50)");
    grad.addColorStop(1, "rgba(34,211,238,0.14)");
    for (const s of p.spans) {
      if (s.e < start || s.s > end) continue;
      const x0 = Math.max(-2, xOf(s.s));
      const x1 = Math.min(width + 2, xOf(Math.min(s.e, now)));
      if (x1 - x0 < 0.3) continue;
      g.fillStyle = grad;
      g.fillRect(x0, TRACK_Y, Math.max(1, x1 - x0), TRACK_H);
      g.fillStyle = "rgba(167,139,250,0.95)";
      g.fillRect(x0, TRACK_Y, Math.max(1, x1 - x0), 2);
    }
    // motion heatmap
    const bw = Math.max(1.5, (10_000 / range) * width);
    for (const [t, score] of p.activity) {
      // Ignore sub-threshold flicker (noise, leaves) so real activity stands out.
      if (score < 0.3 || t < start - 60_000 || t > end) continue;
      const k = Math.min(1, Math.sqrt(score / 6));
      const h = Math.max(3, k * (TRACK_H - 10));
      g.fillStyle = `rgba(251,191,36,${0.3 + 0.6 * k})`;
      g.fillRect(xOf(t), TRACK_Y + TRACK_H - h, bw, h);
    }
    // future
    if (now < end) {
      const xn = Math.max(0, xOf(now));
      g.fillStyle = "rgba(5,7,11,0.7)";
      g.fillRect(xn, TRACK_Y, width - xn, TRACK_H);
      g.strokeStyle = "rgba(255,255,255,0.05)";
      g.lineWidth = 1;
      for (let x = xn - TRACK_H; x < width; x += 9) {
        g.beginPath();
        g.moveTo(x, TRACK_Y + TRACK_H);
        g.lineTo(x + TRACK_H, TRACK_Y);
        g.stroke();
      }
    }
    g.restore();

    // event bars: plain motion in faint amber, people and animals in their colour on top
    const labelled = [];
    for (const e of p.events) {
      const e1 = e.end || now;
      if (e1 < start || e.start > end) continue;
      if (mainLabel(e)) {
        labelled.push(e);
        continue;
      }
      const x0 = xOf(e.start);
      const w = Math.max(4, xOf(e1) - x0);
      const k = Math.min(1, e.peak / 8);
      rr(g, x0, EV_Y + 2, w, EV_H - 4, 3);
      g.fillStyle = `rgba(251,191,36,${0.35 + 0.35 * k})`;
      g.fill();
    }
    for (const e of labelled) {
      const x0 = xOf(e.start);
      const w = Math.max(8, xOf(e.end || now) - x0);
      rr(g, x0 - 1, EV_Y - 1, w + 2, EV_H + 2, 4);
      g.fillStyle = "#0b0f17"; // a surface ring so neighbours stay apart
      g.fill();
      rr(g, x0, EV_Y, w, EV_H, 3);
      g.fillStyle = LABELS[mainLabel(e)!].color;
      g.fill();
      // Seen more than one kind (a person with a dog): a second-colour cap.
      const second = e.labels?.find((l) => l !== mainLabel(e));
      if (second && w > 12) {
        rr(g, x0 + w - 5, EV_Y, 5, EV_H, 2);
        g.fillStyle = LABELS[second].color;
        g.fill();
      }
    }

    // export selection
    if (p.selection) {
      const x0 = xOf(p.selection.from);
      const x1 = xOf(p.selection.to);
      g.fillStyle = "rgba(34,211,238,0.16)";
      g.fillRect(x0, AXIS, x1 - x0, HEIGHT - AXIS);
      g.fillStyle = "#22d3ee";
      for (const x of [x0, x1]) {
        g.fillRect(x - 1, AXIS, 2, HEIGHT - AXIS);
        rr(g, x - 5, TRACK_Y + TRACK_H / 2 - 13, 10, 26, 4);
        g.fill();
        g.fillStyle = "#0b3440";
        g.fillRect(x - 1.5, TRACK_Y + TRACK_H / 2 - 6, 1, 12);
        g.fillRect(x + 0.5, TRACK_Y + TRACK_H / 2 - 6, 1, 12);
        g.fillStyle = "#22d3ee";
      }
    }

    // now marker (when not at the playhead)
    if (now >= start && now <= end && !p.live) {
      g.fillStyle = "rgba(244,63,94,0.85)";
      g.fillRect(xOf(now) - 0.75, AXIS, 1.5, HEIGHT - AXIS);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.spans, p.activity, p.events, p.selection, p.live, center, range, now, width]);

  // ---- gestures ----
  const localX = (clientX: number) => clientX - (canvas.current?.getBoundingClientRect().left ?? 0);

  const beginScrub = () => {
    if (!scrubbing.current) {
      scrubbing.current = true;
      props.current.onScrubStart();
    }
  };
  const finishScrub = (t: number) => {
    scrubbing.current = false;
    setDragging(false);
    props.current.onScrubEnd(clampT(t));
  };

  const animateTo = (target: number) => {
    cancelAnimationFrame(anim.current);
    beginScrub();
    const from = props.current.center;
    const t0 = performance.now();
    const tick = (ts: number) => {
      const k = Math.min(1, (ts - t0) / 260);
      const e = 1 - Math.pow(1 - k, 3);
      const t = clampT(from + (target - from) * e);
      props.current.onScrub(t);
      if (k < 1) anim.current = requestAnimationFrame(tick);
      else finishScrub(t);
    };
    anim.current = requestAnimationFrame(tick);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    cancelAnimationFrame(anim.current);
    (e.target as Element).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, e.clientX);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { x: 0, c0: props.current.center, moved: true, samples: [], pinch: { d0: Math.max(20, Math.abs(a - b)), r0: props.current.range } };
      return;
    }
    const sel = props.current.selection;
    const lx = localX(e.clientX);
    let edge: "from" | "to" | undefined;
    if (sel && props.current.onSelection) {
      if (Math.abs(lx - xOf(sel.from)) < 12) edge = "from";
      else if (Math.abs(lx - xOf(sel.to)) < 12) edge = "to";
    }
    gesture.current = { x: e.clientX, c0: props.current.center, moved: false, samples: [{ x: e.clientX, at: performance.now() }], edge };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, e.clientX);
    if (!g) {
      const x = localX(e.clientX);
      setHover({ x, t: tOf(x) });
      const sel = props.current.selection;
      setOnEdge(!!sel && (Math.abs(x - xOf(sel.from)) < 12 || Math.abs(x - xOf(sel.to)) < 12));
      return;
    }
    if (g.pinch && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const r = g.pinch.r0 * (g.pinch.d0 / Math.max(20, Math.abs(a - b)));
      props.current.onRange(Math.min(MAX_RANGE, Math.max(MIN_RANGE, r)));
      return;
    }
    const dx = e.clientX - g.x;
    if (g.edge) {
      // Dragging a clip handle.
      const sel = props.current.selection!;
      const t = clampT(tOf(localX(e.clientX)));
      props.current.onSelection!(g.edge === "from" ? { from: Math.min(t, sel.to - 1000), to: sel.to } : { from: sel.from, to: Math.max(t, sel.from + 1000) });
      g.moved = true;
      return;
    }
    if (!g.moved && Math.abs(dx) > 4) {
      g.moved = true;
      setDragging(true);
      setHover(null);
      beginScrub();
    }
    if (!g.moved) return;
    g.samples.push({ x: e.clientX, at: performance.now() });
    if (g.samples.length > 6) g.samples.shift();
    props.current.onScrub(clampT(g.c0 - (dx / width) * props.current.range));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (pointers.current.size > 0) return;
    gesture.current = null;
    if (!g) return;
    if (g.pinch || g.edge) return;
    if (!g.moved) {
      // Click: jump there.
      animateTo(clampT(tOf(localX(e.clientX))));
      return;
    }
    // Flick: keep gliding with friction, then settle.
    const s = g.samples;
    const a = s[0];
    const b = s[s.length - 1];
    let v = b && a && b.at - a.at > 0 && performance.now() - b.at < 80 ? (b.x - a.x) / (b.at - a.at) : 0; // px/ms
    let t = props.current.center;
    if (Math.abs(v) < 0.25) return finishScrub(t);
    let last = performance.now();
    const glide = (ts: number) => {
      const dt = ts - last;
      last = ts;
      t = clampT(t - ((v * dt) / width) * props.current.range);
      v *= Math.pow(0.94, dt / 16);
      props.current.onScrub(t);
      if (Math.abs(v) > 0.02 && t < props.current.now) anim.current = requestAnimationFrame(glide);
      else finishScrub(t);
    };
    anim.current = requestAnimationFrame(glide);
  };

  // Wheel: vertical zooms around the playhead; horizontal (trackpad) or shift+wheel scrubs.
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey;
      if (horizontal) {
        const d = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
        beginScrub();
        const t = clampT(props.current.center + (d / width) * props.current.range);
        props.current.onScrub(t);
        window.clearTimeout(wheelEnd.current);
        wheelEnd.current = window.setTimeout(() => finishScrub(props.current.center), 250);
        return;
      }
      const r = props.current.range * Math.exp(e.deltaY * 0.0015);
      props.current.onRange(Math.min(MAX_RANGE, Math.max(MIN_RANGE, r)));
    };
    c.addEventListener("wheel", onWheel, { passive: false });
    return () => c.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width]);

  const hoverT = hover && !dragging && hover.t < now ? hover.t : null;
  const thumb = usePreviewFrame(hoverT !== null ? p.camera : null, hoverT);
  const near = hover ? p.events.filter((e) => hover.t >= e.start - (4 / width) * range - 2000 && hover.t <= (e.end || now) + (4 / width) * range + 2000) : [];
  // Prefer a person/animal under the pointer: its snapshot beats the preview frame.
  const hoverEvent = near.find((e) => mainLabel(e)) ?? near[0];
  const hoverLabel = hoverEvent && mainLabel(hoverEvent);

  return (
    <div ref={wrap} className="relative w-full select-none">
      <canvas
        ref={canvas}
        style={{ width, height: HEIGHT, touchAction: "none" }}
        className={clsx("block", onEdge ? "cursor-ew-resize" : dragging ? "cursor-grabbing" : "cursor-grab")}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => setHover(null)}
      />
      {/* Playhead */}
      <div className="pointer-events-none absolute bottom-0 left-1/2 -translate-x-1/2" style={{ top: AXIS - 2 }}>
        <div className={clsx("mx-auto h-full w-[2px] rounded-full", p.live ? "bg-rose-500 shadow-[0_0_12px_rgba(244,63,94,0.9)]" : "bg-white shadow-[0_0_12px_rgba(255,255,255,0.8)]")} />
      </div>
      <div className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 -translate-y-[60%]">
        <div className={clsx("whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-bold tabular-nums shadow-lg", p.live ? "bg-rose-500 text-white" : "bg-white text-ink-950")}>
          {p.live ? "LIVE" : fmtTimeSec(center)}
        </div>
      </div>
      {/* Hover preview */}
      {hover && hoverT !== null && (
        <div
          className="pointer-events-none absolute z-20 w-44 -translate-x-1/2 overflow-hidden rounded-xl border border-white/15 bg-ink-900 shadow-2xl shadow-black/60"
          style={{ left: Math.min(width - 88, Math.max(88, hover.x)), bottom: HEIGHT + 8 }}
        >
          <div className="aspect-video bg-ink-800">
            {hoverLabel && hoverEvent?.snap ? (
              <img src={snapURL(hoverEvent, true)} className="h-full w-full object-cover" />
            ) : thumb?.url ? (
              <img src={thumb.url} className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full items-center justify-center text-[10px] text-slate-500">{thumb ? "No preview" : "…"}</div>
            )}
          </div>
          <div className="flex items-center justify-between px-2 py-1 text-[11px]">
            <span className="font-semibold text-white">{fmtTimeSec(hoverLabel ? hoverEvent!.start : hover.t)}</span>
            {hoverLabel ? (
              <span className="flex items-center gap-1 font-semibold text-white">
                <span className="size-2 rounded-full" style={{ background: LABELS[hoverLabel].color }} />
                {hoverEvent!.labels!.map((l) => LABELS[l].name).join(" + ")}
              </span>
            ) : (
              hoverEvent && <span className="font-medium text-amber-300">Motion</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function rr(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
