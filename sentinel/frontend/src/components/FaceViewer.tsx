import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import clsx from "clsx";
import { ChevronLeft, ChevronRight, ImageOff, Loader2, Maximize2, Minimize2, PlayCircle, X } from "lucide-react";
import { useStatus } from "../lib/status";
import { faceURL, type FaceInfo, type PersonInfo, type Rect } from "../lib/api";
import { fmtDay, fmtTimeSec } from "../lib/format";
import { NamePicker, type Pick } from "./NamePicker";

export const faceFrameURL = (id: string) => `api/faces/${id}/frame.jpg`;

export type ViewerAction = { label: string; icon?: ReactNode; tone?: "danger" | "plain"; onClick: (f: FaceInfo) => void };

// A face in full quality: the frame it was taken from (straight from the recording),
// zoomed in on the person with the face outlined; "Whole picture" zooms out. Name the
// face (or do something else with it) right here; ← / → go through the others.
export function FaceViewer({
  faces,
  index,
  onIndex,
  onClose,
  people,
  onName,
  actions = [],
  title,
}: {
  faces: FaceInfo[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  people?: PersonInfo[];
  onName?: (f: FaceInfo, p: Pick) => void;
  actions?: ViewerAction[];
  title?: string;
}) {
  const f = faces[index];
  const nav = useNavigate();
  const { status } = useStatus();
  const cam = status?.cameras.find((c) => c.id === f?.cam)?.name ?? f?.cam;
  const [whole, setWhole] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onClose();
      if ((e.target as HTMLElement)?.closest("input")) return;
      else if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
      else if (e.key === "ArrowRight" && index < faces.length - 1) onIndex(index + 1);
      else if (e.key === "z" || e.key === "Z") setWhole((w) => !w);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, faces.length, onClose, onIndex]);
  // No scrolling the page underneath.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  if (!f) return null;
  return createPortal(
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[80] flex flex-col bg-black/95 backdrop-blur-sm lg:flex-row">
      {/* Picture */}
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-x-0 top-0 z-10 flex items-center gap-3 bg-gradient-to-b from-black/80 to-transparent p-3">
          <button onClick={onClose} title="Close (Esc)" className="flex size-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20">
            <X className="size-5" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-white">{title ?? cam}</div>
            <div className="text-xs text-white/60">
              {title ? `${cam} · ` : ""}
              {fmtDay(f.t)} · {fmtTimeSec(f.t)}
              {faces.length > 1 && ` · ${index + 1} of ${faces.length}`}
            </div>
          </div>
          <button
            onClick={() => setWhole((w) => !w)}
            title="Zoom (Z)"
            className="flex h-10 items-center gap-2 rounded-full bg-white/10 px-4 text-sm font-medium text-white hover:bg-white/20"
          >
            {whole ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />} {whole ? "Close-up" : "Whole picture"}
          </button>
        </div>
        <Stage key={f.id} f={f} whole={whole} />
        {index > 0 && (
          <button onClick={() => onIndex(index - 1)} title="Previous (←)" className="absolute left-3 top-1/2 flex size-12 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70">
            <ChevronLeft className="size-6" />
          </button>
        )}
        {index < faces.length - 1 && (
          <button onClick={() => onIndex(index + 1)} title="Next (→)" className="absolute right-3 top-1/2 flex size-12 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70">
            <ChevronRight className="size-6" />
          </button>
        )}
        {/* Filmstrip */}
        {faces.length > 1 && (
          <div className="absolute inset-x-0 bottom-0 flex justify-center gap-1.5 overflow-x-auto bg-gradient-to-t from-black/80 to-transparent px-3 pb-3 pt-8">
            {faces.map((x, i) => (
              <button
                key={x.id}
                onClick={() => onIndex(i)}
                className={clsx("size-12 shrink-0 overflow-hidden rounded-lg transition", i === index ? "ring-2 ring-white" : "opacity-50 hover:opacity-100")}
              >
                <img src={faceURL(x.id)} alt="" className="h-full w-full object-cover" />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* What to do */}
      <div className="w-full shrink-0 border-t border-white/10 bg-ink-950 p-4 lg:w-[340px] lg:border-l lg:border-t-0 lg:p-5">
        <div className="flex items-center gap-3">
          <img src={faceURL(f.id)} alt="" className="size-16 rounded-2xl object-cover ring-1 ring-white/10" />
          <div className="min-w-0">
            <div className="truncate text-base font-semibold text-white">{f.name || "Unknown"}</div>
            <div className="text-xs text-slate-400">
              {f.by === "you" ? "Named by you" : f.by === "face" ? `Recognised (${Math.round((f.sim ?? 0) * 100)}% alike)` : "Not known yet"} · clarity {Math.round(f.q * 100)}%
            </div>
          </div>
        </div>
        {onName && people && (
          <div className="mt-4">
            <div className="mb-1.5 text-xs font-medium text-slate-400">{f.name ? "Someone else? Pick or type the right name" : "Who is this?"}</div>
            <NamePicker key={f.id} people={people} onPick={(p) => onName(f, p)} />
          </div>
        )}
        <div className="mt-4 flex flex-col gap-2">
          {actions.map((a) => (
            <button
              key={a.label}
              onClick={() => a.onClick(f)}
              className={clsx(
                "flex h-10 items-center gap-2 rounded-xl border px-3 text-sm font-medium transition",
                a.tone === "danger" ? "border-rose-400/20 text-rose-200 hover:bg-rose-500/10" : "border-white/10 text-slate-200 hover:bg-white/5",
              )}
            >
              {a.icon} {a.label}
            </button>
          ))}
          <button
            onClick={() => nav(`/camera/${f.cam}?t=${f.t - 3000}`)}
            className="flex h-10 items-center gap-2 rounded-xl border border-white/10 px-3 text-sm font-medium text-slate-200 transition hover:bg-white/5"
          >
            <PlayCircle className="size-4" /> Watch this moment
          </button>
        </div>
        <p className="mt-4 hidden text-[11px] text-slate-500 lg:block">← → other faces · Z zoom · Esc close</p>
      </div>
    </motion.div>,
    document.body,
  );
}

// The frame, transformed so the person (or the whole picture) fills the stage.
function Stage({ f, whole }: { f: FaceInfo; whole: boolean }) {
  const stage = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [img, setImg] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);

  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const region = (): Rect => {
    if (whole || !img) return { x: 0, y: 0, w: 1, h: 1 };
    // The person with room around them, at least a few face-widths, kept in the frame.
    const b = f.box;
    const fw = f.face ? f.face.w : b.w / 3;
    const w = Math.min(1, Math.max(b.w * 1.5, fw * 6));
    const h = Math.min(1, Math.max(b.h * 1.2, fw * 6 * (img.w / img.h)));
    const cx = f.face ? f.face.x + f.face.w / 2 : b.x + b.w / 2;
    const cy = f.face ? Math.min(f.face.y + f.face.h * 2, b.y + b.h / 2) : b.y + b.h / 2;
    return { x: Math.min(Math.max(cx - w / 2, 0), 1 - w), y: Math.min(Math.max(cy - h / 2, 0), 1 - h), w, h };
  };

  let style = {};
  let z = 1;
  if (img && size.w) {
    const r = region();
    z = Math.min(size.w / (r.w * img.w), size.h / (r.h * img.h));
    const tx = size.w / 2 - (r.x + r.w / 2) * img.w * z;
    const ty = size.h / 2 - (r.y + r.h / 2) * img.h * z;
    style = { width: img.w, height: img.h, transform: `translate(${tx}px, ${ty}px) scale(${z})` };
  }

  return (
    <div ref={stage} className="absolute inset-0 overflow-hidden">
      {failed ? (
        <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-slate-400">
          <img src={faceURL(f.id)} alt="" className="size-64 rounded-3xl object-cover" />
          <span className="flex items-center gap-2">
            <ImageOff className="size-4" /> The recording of this moment is gone; this is the saved face.
          </span>
        </div>
      ) : (
        <>
          {!img && (
            <div className="absolute inset-0 flex items-center justify-center">
              <img src={faceURL(f.id)} alt="" className="size-72 rounded-3xl object-cover opacity-60 blur-[1px]" />
              <Loader2 className="absolute size-8 animate-spin text-white/70" />
            </div>
          )}
          <div className={clsx("absolute left-0 top-0 origin-top-left transition-transform duration-500 ease-out", !img && "invisible")} style={style}>
            <img
              src={faceFrameURL(f.id)}
              alt=""
              draggable={false}
              onLoad={(e) => setImg({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
              onError={() => setFailed(true)}
              className="h-full w-full select-none"
            />
            <AnimatePresence>
              {f.face && img && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="pointer-events-none absolute rounded-[10%] border-2 border-pink-400 shadow-[0_0_0_9999px_rgba(0,0,0,0.25)]"
                  style={{ left: `${f.face.x * 100}%`, top: `${f.face.y * 100}%`, width: `${f.face.w * 100}%`, height: `${f.face.h * 100}%`, borderWidth: 2.5 / z }}
                />
              )}
            </AnimatePresence>
          </div>
        </>
      )}
    </div>
  );
}
