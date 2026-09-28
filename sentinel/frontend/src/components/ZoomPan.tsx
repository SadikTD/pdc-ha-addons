import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Minus, Plus, Maximize } from "lucide-react";

// Digital zoom for the player: scroll to zoom toward the cursor, drag to pan, double-click
// to zoom in / reset, pinch on touch screens. Keys: + / - / 0.

const MAX = 8;
type View = { s: number; x: number; y: number };

export function ZoomPan({ children, resetKey }: { children: ReactNode; resetKey?: unknown }) {
  const box = useRef<HTMLDivElement>(null);
  const [v, setV] = useState<View>({ s: 1, x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const view = useRef(v);
  view.current = v;
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ x: number; y: number; v: View; dist?: number; mid?: { x: number; y: number } } | null>(null);

  useEffect(() => setV({ s: 1, x: 0, y: 0 }), [resetKey]);

  const clamp = (n: View): View => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return n;
    const s = Math.min(MAX, Math.max(1, n.s));
    return { s, x: Math.min(0, Math.max(r.width - r.width * s, n.x)), y: Math.min(0, Math.max(r.height - r.height * s, n.y)) };
  };

  // Zoom to scale s keeping the point (px, py) (relative to the box) fixed on screen.
  const zoomAt = (s: number, px: number, py: number, from = view.current) => {
    const k = Math.min(MAX, Math.max(1, s)) / from.s;
    setV(clamp({ s: from.s * k, x: px - (px - from.x) * k, y: py - (py - from.y) * k }));
  };

  const zoomCenter = (f: number) => {
    const r = box.current!.getBoundingClientRect();
    zoomAt(view.current.s * f, r.width / 2, r.height / 2);
  };

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(view.current.s * Math.exp(-e.deltaY * 0.0018), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input,textarea,select")) return;
      if (e.key === "+" || e.key === "=") zoomCenter(1.5);
      else if (e.key === "-") zoomCenter(1 / 1.5);
      else if (e.key === "0") setV({ s: 1, x: 0, y: 0 });
    };
    window.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = box.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    pointers.current.set(e.pointerId, local(e));
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { x: 0, y: 0, v: view.current, dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
    } else if (view.current.s > 1) {
      (e.target as Element).setPointerCapture(e.pointerId);
      const p = local(e);
      gesture.current = { x: p.x, y: p.y, v: view.current };
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, local(e));
    const g = gesture.current;
    if (!g) return;
    if (g.dist && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      zoomAt(g.v.s * (Math.hypot(a.x - b.x, a.y - b.y) / g.dist), g.mid!.x, g.mid!.y, g.v);
      return;
    }
    const p = local(e);
    setPanning(true);
    setV(clamp({ s: g.v.s, x: g.v.x + p.x - g.x, y: g.v.y + p.y - g.y }));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0) {
      gesture.current = null;
      setPanning(false);
    }
  };

  const zoomed = v.s > 1.01;
  return (
    <div
      ref={box}
      className="absolute inset-0 overflow-hidden"
      style={{ touchAction: zoomed ? "none" : "pan-y", cursor: zoomed ? (panning ? "grabbing" : "grab") : "zoom-in" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={(e) => {
        const p = local(e);
        if (zoomed) setV({ s: 1, x: 0, y: 0 });
        else zoomAt(2.5, p.x, p.y);
      }}
    >
      <div
        className="absolute inset-0 origin-top-left will-change-transform"
        style={{ transform: `translate(${v.x}px, ${v.y}px) scale(${v.s})`, transition: panning || gesture.current ? "none" : "transform 120ms ease-out" }}
      >
        {children}
      </div>

      <AnimatePresence>
        {zoomed && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            className="absolute bottom-3 right-3 flex items-center gap-2"
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <Minimap v={v} box={box.current} />
            <div className="flex items-center rounded-xl bg-black/65 p-1 text-white backdrop-blur">
              <button className="rounded-lg p-1.5 hover:bg-white/15" title="Zoom out (-)" onClick={() => zoomCenter(1 / 1.5)}>
                <Minus className="size-3.5" />
              </button>
              <span className="w-10 text-center text-xs font-semibold tabular-nums">{v.s.toFixed(1)}×</span>
              <button className="rounded-lg p-1.5 hover:bg-white/15" title="Zoom in (+)" onClick={() => zoomCenter(1.5)}>
                <Plus className="size-3.5" />
              </button>
              <button className="rounded-lg p-1.5 hover:bg-white/15" title="Reset zoom (0)" onClick={() => setV({ s: 1, x: 0, y: 0 })}>
                <Maximize className="size-3.5" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Small overview showing which part of the picture is visible.
function Minimap({ v, box }: { v: View; box: HTMLDivElement | null }) {
  if (!box) return null;
  const w = 64;
  const h = (box.clientHeight / box.clientWidth) * w;
  return (
    <div className="relative rounded-md border border-white/30 bg-black/50 backdrop-blur" style={{ width: w, height: h }}>
      <div
        className="absolute rounded-sm border-2 border-cyan-300 bg-cyan-300/20"
        style={{ left: (-v.x / (box.clientWidth * v.s)) * w, top: (-v.y / (box.clientHeight * v.s)) * h, width: w / v.s, height: h / v.s }}
      />
    </div>
  );
}
