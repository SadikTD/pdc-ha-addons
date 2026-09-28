import { useRef, useState } from "react";
import { X, Loader2 } from "lucide-react";
import type { Rect } from "../lib/api";
import { snapshotURL } from "../lib/api";

// Draw rectangles on a snapshot; motion inside them is ignored (timestamps, trees, busy roads).
export function MaskEditor({ camera, masks, onChange }: { camera: string; masks: Rect[]; onChange: (m: Rect[]) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Rect | null>(null);
  const [loaded, setLoaded] = useState(false);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const [bust] = useState(Date.now());

  const pt = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };

  return (
    <div>
      <div
        ref={box}
        className="relative aspect-video cursor-crosshair overflow-hidden rounded-xl border border-white/10 bg-ink-900"
        style={{ touchAction: "none" }}
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          (e.target as Element).setPointerCapture(e.pointerId);
          origin.current = pt(e);
          setDraft({ ...origin.current, w: 0, h: 0 });
        }}
        onPointerMove={(e) => {
          if (!origin.current) return;
          const p = pt(e);
          const o = origin.current;
          setDraft({ x: Math.min(o.x, p.x), y: Math.min(o.y, p.y), w: Math.abs(p.x - o.x), h: Math.abs(p.y - o.y) });
        }}
        onPointerUp={() => {
          if (draft && draft.w > 0.01 && draft.h > 0.01) onChange([...masks, round(draft)]);
          origin.current = null;
          setDraft(null);
        }}
      >
        <img src={snapshotURL(camera, false, bust)} onLoad={() => setLoaded(true)} className="h-full w-full select-none object-cover" draggable={false} />
        {!loaded && <Loader2 className="absolute inset-0 m-auto size-6 animate-spin text-white/50" />}
        {masks.map((m, i) => (
          <div
            key={i}
            className="absolute border-2 border-rose-400/80 bg-[repeating-linear-gradient(45deg,rgba(244,63,94,0.35)_0_6px,rgba(244,63,94,0.15)_6px_12px)]"
            style={{ left: `${m.x * 100}%`, top: `${m.y * 100}%`, width: `${m.w * 100}%`, height: `${m.h * 100}%` }}
          >
            <button
              type="button"
              onClick={() => onChange(masks.filter((_, j) => j !== i))}
              className="absolute -right-2.5 -top-2.5 flex size-5 items-center justify-center rounded-full bg-rose-500 text-white shadow"
              title="Remove zone"
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
        {draft && (
          <div
            className="absolute border-2 border-dashed border-cyan-300 bg-cyan-300/15"
            style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, width: `${draft.w * 100}%`, height: `${draft.h * 100}%` }}
          />
        )}
      </div>
      <p className="mt-2 text-xs text-slate-500">Drag on the picture to add an ignore zone. Motion inside red zones is ignored.</p>
    </div>
  );
}

const round = (r: Rect): Rect => ({ x: +r.x.toFixed(4), y: +r.y.toFixed(4), w: +r.w.toFixed(4), h: +r.h.toFixed(4) });
