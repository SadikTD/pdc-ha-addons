import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import clsx from "clsx";
import { Activity, Eraser, Loader2, MousePointer2, Pentagon, Pencil, RectangleHorizontal, Trash2, Undo2, X } from "lucide-react";
import { Button, IconButton } from "./ui";
import { api, snapshotURL, type Rect, type Zone } from "../lib/api";

type Pt = [number, number];
type Tool = "select" | "rect" | "poly";

export const rectToZone = (r: Rect, i: number): Zone => ({
  name: `Zone ${i + 1}`,
  points: [
    [r.x, r.y],
    [r.x + r.w, r.y],
    [r.x + r.w, r.y + r.h],
    [r.x, r.y + r.h],
  ],
});

const r4 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000;
const COLORS = ["#f43f5e", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#8b5cf6", "#ec4899"];

// Summary shown in the camera editor: the picture with its zones, and a button that opens
// the full-size editor.
export function ZoneSummary({ camera, zones, onChange }: { camera: string; zones: Zone[]; onChange: (z: Zone[]) => void }) {
  const [open, setOpen] = useState(false);
  const [bust] = useState(Date.now());
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)} className="group relative block aspect-video w-full overflow-hidden rounded-xl border border-white/10 bg-ink-900">
        <img src={snapshotURL(camera, false, bust)} className="h-full w-full object-fill" draggable={false} />
        <svg viewBox="0 0 1 1" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
          {zones.map((z, i) => (
            <polygon key={i} points={z.points.map((p) => p.join(",")).join(" ")} fill={COLORS[i % COLORS.length]} fillOpacity={0.3} stroke={COLORS[i % COLORS.length]} strokeWidth={0.004} />
          ))}
        </svg>
        <span className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition group-hover:opacity-100">
          <span className="flex items-center gap-2 rounded-xl bg-white/90 px-3 py-1.5 text-sm font-semibold text-ink-950">
            <Pencil className="size-4" /> Edit zones
          </span>
        </span>
      </button>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-xs text-slate-500">{zones.length ? `${zones.length} ignore zone${zones.length > 1 ? "s" : ""}. Motion inside them is ignored.` : "No ignore zones: motion anywhere in the picture counts."}</span>
        <Button type="button" size="sm" onClick={() => setOpen(true)}>
          <Pentagon className="size-3.5" /> {zones.length ? "Edit zones" : "Add zones"}
        </Button>
      </div>
      {createPortal(
        <AnimatePresence>
          {open && (
            <ZoneEditorModal
              camera={camera}
              initial={zones}
              onClose={() => setOpen(false)}
              onSave={(z) => {
                onChange(z);
                setOpen(false);
              }}
            />
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}

function ZoneEditorModal({ camera, initial, onClose, onSave }: { camera: string; initial: Zone[]; onClose: () => void; onSave: (z: Zone[]) => void }) {
  const [zones, setZones] = useState<Zone[]>(initial);
  const [history, setHistory] = useState<Zone[][]>([]);
  const [tool, setTool] = useState<Tool>(initial.length ? "select" : "rect");
  const [sel, setSel] = useState<number | null>(null);
  const [draft, setDraft] = useState<Pt[]>([]); // polygon being drawn, or rectangle corners
  const [cursor, setCursor] = useState<Pt | null>(null);
  const [live, setLive] = useState(true);
  const [aspect, setAspect] = useState(16 / 9);
  const [loaded, setLoaded] = useState(false);
  const [bust] = useState(Date.now());
  const box = useRef<HTMLDivElement>(null);
  const heat = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ kind: "vertex" | "move" | "rect" | "mid"; zone: number; index: number; start: Pt; orig: Pt[] } | null>(null);

  const commit = (next: Zone[]) => {
    setHistory((h) => [...h.slice(-30), zones]);
    setZones(next);
  };
  const undo = () => {
    if (draft.length) return setDraft([]);
    const prev = history.at(-1);
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    setZones(prev);
    setSel(null);
  };

  const pt = (e: { clientX: number; clientY: number }): Pt => {
    const r = box.current!.getBoundingClientRect();
    return [r4((e.clientX - r.left) / r.width), r4((e.clientY - r.top) / r.height)];
  };

  // Live motion: where the detector currently sees movement (amber) or ignores it (grey).
  useEffect(() => {
    if (!live) return;
    let alive = true;
    let busy = false; // one request at a time, even on a slow connection
    const draw = async () => {
      if (busy) return;
      busy = true;
      try {
        const g = await api.motionGrid(camera);
        const c = heat.current;
        if (!alive || !c || !g.grid) return;
        const bytes = Uint8Array.from(atob(g.grid), (ch) => ch.charCodeAt(0));
        c.width = g.w;
        c.height = g.h;
        const ctx = c.getContext("2d")!;
        const img = ctx.createImageData(g.w, g.h);
        for (let i = 0; i < bytes.length; i++) {
          const v = bytes[i];
          if (!v) continue;
          img.data.set(v === 1 ? [251, 191, 36, 230] : [148, 163, 184, 150], i * 4);
        }
        ctx.putImageData(img, 0, 0);
      } catch {
        /* motion detection off */
      } finally {
        busy = false;
      }
    };
    draw();
    const t = window.setInterval(draw, 400);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [camera, live]);

  const finishPoly = () => {
    if (draft.length >= 3) {
      commit([...zones, { name: `Zone ${zones.length + 1}`, points: draft }]);
      setSel(zones.length);
    }
    setDraft([]);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input")) return;
      if (e.key === "Escape") draft.length ? setDraft([]) : sel !== null ? setSel(null) : onClose();
      else if (e.key === "Enter" && tool === "poly") finishPoly();
      else if ((e.key === "Delete" || e.key === "Backspace") && sel !== null) {
        commit(zones.filter((_, i) => i !== sel));
        setSel(null);
      } else if ((e.ctrlKey || e.metaKey) && e.key === "z") undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const onDown = (e: React.PointerEvent) => {
    const p = pt(e);
    const target = e.target as SVGElement;
    const vertex = target.dataset.vertex;
    const mid = target.dataset.mid;
    const zoneIdx = target.dataset.zone;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    if (tool === "select" && vertex !== undefined && sel !== null) {
      drag.current = { kind: "vertex", zone: sel, index: Number(vertex), start: p, orig: zones[sel].points };
      setHistory((h) => [...h.slice(-30), zones]);
      return;
    }
    if (tool === "select" && mid !== undefined && sel !== null) {
      // Dragging an edge's midpoint inserts a new corner there.
      const i = Number(mid) + 1;
      const pts = [...zones[sel].points.slice(0, i), p, ...zones[sel].points.slice(i)];
      commit(zones.map((z, j) => (j === sel ? { ...z, points: pts } : z)));
      drag.current = { kind: "vertex", zone: sel, index: i, start: p, orig: pts };
      return;
    }
    if (tool === "select") {
      if (zoneIdx !== undefined) {
        const zi = Number(zoneIdx);
        setSel(zi);
        drag.current = { kind: "move", zone: zi, index: -1, start: p, orig: zones[zi].points };
        setHistory((h) => [...h.slice(-30), zones]);
      } else setSel(null);
      return;
    }
    if (tool === "rect") {
      drag.current = { kind: "rect", zone: -1, index: -1, start: p, orig: [] };
      setDraft([p, p]);
      return;
    }
    // Polygon: click to add corners; clicking the first corner closes it.
    if (draft.length >= 3) {
      const [fx, fy] = draft[0];
      const r = box.current!.getBoundingClientRect();
      if (Math.hypot((p[0] - fx) * r.width, (p[1] - fy) * r.height) < 12) return finishPoly();
    }
    setDraft((d) => [...d, p]);
  };

  const onMove = (e: React.PointerEvent) => {
    const p = pt(e);
    setCursor(p);
    const d = drag.current;
    if (!d) return;
    if (d.kind === "rect") {
      setDraft([d.start, p]);
    } else if (d.kind === "vertex") {
      setZones((zs) => zs.map((z, j) => (j === d.zone ? { ...z, points: z.points.map((q, k) => (k === d.index ? p : q)) } : z)));
    } else if (d.kind === "move") {
      const dx = p[0] - d.start[0];
      const dy = p[1] - d.start[1];
      const minX = Math.min(...d.orig.map((q) => q[0]));
      const maxX = Math.max(...d.orig.map((q) => q[0]));
      const minY = Math.min(...d.orig.map((q) => q[1]));
      const maxY = Math.max(...d.orig.map((q) => q[1]));
      const cx = Math.min(Math.max(dx, -minX), 1 - maxX);
      const cy = Math.min(Math.max(dy, -minY), 1 - maxY);
      setZones((zs) => zs.map((z, j) => (j === d.zone ? { ...z, points: d.orig.map(([x, y]) => [r4(x + cx), r4(y + cy)] as Pt) } : z)));
    }
  };

  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.kind === "rect" && draft.length === 2) {
      const [[x0, y0], [x1, y1]] = draft;
      const r = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
      setDraft([]);
      if (r.w > 0.01 && r.h > 0.01) {
        commit([...zones, rectToZone(r, zones.length)]);
        setSel(zones.length);
      }
    }
  };

  const rectPts = (a: Pt, b: Pt): Pt[] => [a, [b[0], a[1]], b, [a[0], b[1]]];
  const hint =
    tool === "rect"
      ? "Drag on the picture to draw a rectangle."
      : tool === "poly"
        ? draft.length
          ? "Click to add corners. Click the first corner (or press Enter) to finish, Esc to cancel."
          : "Click around the area to outline any shape (trees, a road, a neighbour's window)."
        : sel !== null
          ? "Drag the zone to move it, drag corners to reshape, drag the small dots to add corners. Delete removes it."
          : "Click a zone to change it.";

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-3 backdrop-blur-sm md:p-6">
      <motion.div initial={{ scale: 0.97, y: 10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.97 }} className="flex max-h-full w-full max-w-7xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-ink-900 shadow-2xl">
        <div className="flex flex-wrap items-center gap-2 border-b border-white/5 px-4 py-3">
          <h2 className="mr-2 text-lg font-semibold text-white">Ignore zones</h2>
          <div className="flex rounded-xl bg-white/5 p-0.5">
            {(
              [
                ["select", MousePointer2, "Select & edit"],
                ["rect", RectangleHorizontal, "Rectangle"],
                ["poly", Pentagon, "Any shape"],
              ] as const
            ).map(([t, I, label]) => (
              <button
                key={t}
                type="button"
                onClick={() => {
                  setTool(t);
                  setDraft([]);
                }}
                className={clsx("flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition", tool === t ? "bg-violet-500 text-white" : "text-slate-400 hover:text-white")}
              >
                <I className="size-3.5" /> {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setLive((l) => !l)}
            className={clsx("flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-xs font-medium transition", live ? "border-amber-400/40 bg-amber-400/10 text-amber-200" : "border-white/10 text-slate-400 hover:text-white")}
            title="Show where Sentinel sees motion right now"
          >
            <Activity className="size-3.5" /> Live motion
          </button>
          <div className="ml-auto flex items-center gap-1">
            <IconButton type="button" title="Undo (Ctrl+Z)" onClick={undo} disabled={!history.length && !draft.length}>
              <Undo2 className="size-4" />
            </IconButton>
            <IconButton type="button" title="Remove all zones" onClick={() => (commit([]), setSel(null))} disabled={!zones.length}>
              <Eraser className="size-4" />
            </IconButton>
            <IconButton type="button" title="Close without saving (Esc)" onClick={onClose}>
              <X className="size-5" />
            </IconButton>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4 lg:flex-row">
          <div className="min-w-0 flex-1">
            <div
              ref={box}
              className={clsx("relative w-full select-none overflow-hidden rounded-xl bg-black", tool === "select" ? "cursor-default" : "cursor-crosshair")}
              style={{ aspectRatio: aspect, touchAction: "none" }}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerLeave={() => setCursor(null)}
              onDoubleClick={() => tool === "poly" && finishPoly()}
            >
              <img
                src={snapshotURL(camera, false, bust)}
                onLoad={(e) => {
                  setLoaded(true);
                  const i = e.currentTarget;
                  if (i.naturalWidth && i.naturalHeight) setAspect(i.naturalWidth / i.naturalHeight);
                }}
                className="pointer-events-none h-full w-full object-fill"
                draggable={false}
              />
              {!loaded && <Loader2 className="absolute inset-0 m-auto size-7 animate-spin text-white/50" />}
              {live && <canvas ref={heat} className="pointer-events-none absolute inset-0 h-full w-full opacity-70 [image-rendering:pixelated]" />}
              <svg viewBox="0 0 1 1" preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible">
                {zones.map((z, i) => {
                  const c = COLORS[i % COLORS.length];
                  const on = sel === i;
                  return (
                    <polygon
                      key={i}
                      data-zone={i}
                      points={z.points.map((p) => p.join(",")).join(" ")}
                      fill={c}
                      fillOpacity={on ? 0.35 : 0.25}
                      stroke={c}
                      strokeWidth={on ? 3 : 2}
                      vectorEffect="non-scaling-stroke"
                      className={tool === "select" ? "cursor-move" : "pointer-events-none"}
                    />
                  );
                })}
                {draft.length > 0 && tool === "rect" && draft.length === 2 && (
                  <polygon points={rectPts(draft[0], draft[1]).map((p) => p.join(",")).join(" ")} fill="#22d3ee" fillOpacity={0.15} stroke="#22d3ee" strokeWidth={2} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" className="pointer-events-none" />
                )}
                {tool === "poly" && draft.length > 0 && (
                  <polyline
                    points={[...draft, ...(cursor ? [cursor] : [])].map((p) => p.join(",")).join(" ")}
                    fill="#22d3ee"
                    fillOpacity={0.12}
                    stroke="#22d3ee"
                    strokeWidth={2}
                    strokeDasharray="6 4"
                    vectorEffect="non-scaling-stroke"
                    className="pointer-events-none"
                  />
                )}
              </svg>
              {/* Handles are HTML so they keep a constant size. */}
              {tool === "poly" &&
                draft.map((p, i) => (
                  <span key={i} className={clsx("pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-cyan-400", i === 0 && draft.length >= 3 ? "size-4" : "size-2.5")} style={{ left: `${p[0] * 100}%`, top: `${p[1] * 100}%` }} />
                ))}
              {tool === "select" &&
                sel !== null &&
                zones[sel] &&
                zones[sel].points.map((p, i, pts) => {
                  const n = pts[(i + 1) % pts.length];
                  return (
                    <span key={i}>
                      <span data-vertex={i} className="absolute size-3.5 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border-2 border-white bg-violet-500 shadow" style={{ left: `${p[0] * 100}%`, top: `${p[1] * 100}%` }} />
                      <span data-mid={i} title="Drag to add a corner" className="absolute size-2 -translate-x-1/2 -translate-y-1/2 cursor-copy rounded-full bg-white/70" style={{ left: `${((p[0] + n[0]) / 2) * 100}%`, top: `${((p[1] + n[1]) / 2) * 100}%` }} />
                    </span>
                  );
                })}
            </div>
            <p className="mt-2 text-xs text-slate-400">{hint}</p>
            {live && (
              <p className="mt-1 flex items-center gap-3 text-[11px] text-slate-500">
                <span className="flex items-center gap-1.5"><span className="size-2 rounded-sm bg-amber-400" /> Motion that counts</span>
                <span className="flex items-center gap-1.5"><span className="size-2 rounded-sm bg-slate-400" /> Motion ignored by a zone</span>
              </p>
            )}
          </div>

          <div className="flex shrink-0 flex-col gap-2 lg:w-64">
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">Zones</div>
            {zones.length === 0 && <div className="rounded-xl border border-dashed border-white/10 p-4 text-center text-xs text-slate-500">None yet. Draw one on the picture.</div>}
            {zones.map((z, i) => (
              <div
                key={i}
                onClick={() => (setTool("select"), setSel(i))}
                className={clsx("flex cursor-pointer items-center gap-2 rounded-xl border px-2.5 py-2 transition", sel === i ? "border-violet-400/40 bg-violet-500/10" : "border-white/5 hover:bg-white/5")}
              >
                <span className="size-3 shrink-0 rounded" style={{ background: COLORS[i % COLORS.length] }} />
                <input
                  value={z.name}
                  onChange={(e) => setZones(zones.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                  className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none"
                />
                <span className="text-[10px] text-slate-500">{z.points.length} pts</span>
                <IconButton
                  type="button"
                  title="Remove"
                  className="size-7 hover:text-rose-300"
                  onClick={(e) => {
                    e.stopPropagation();
                    commit(zones.filter((_, j) => j !== i));
                    setSel(null);
                  }}
                >
                  <Trash2 className="size-3.5" />
                </IconButton>
              </div>
            ))}
            <div className="mt-auto flex gap-2 pt-3">
              <Button type="button" variant="ghost" className="flex-1" onClick={onClose}>
                Cancel
              </Button>
              <Button type="button" variant="primary" className="flex-1" onClick={() => onSave(zones)}>
                Done
              </Button>
            </div>
            <p className="text-[11px] text-slate-500">Press Save camera afterwards to apply. Recording isn't interrupted.</p>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
