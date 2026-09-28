import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import clsx from "clsx";
import { CalendarClock, CornerDownLeft } from "lucide-react";
import { parseWhen } from "../lib/parseWhen";
import { fmtDay, fmtTimeSec } from "../lib/format";

const QUICK: [string, string][] = [
  ["5 min ago", "5 min ago"],
  ["1 hour ago", "1h ago"],
  ["Last night 11 pm", "11pm"],
  ["This time yesterday", "yesterday"],
];

function toLocalInput(ms: number) {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 19);
}

// "Go to" a moment: type it the way you'd say it, or pick a date and time.
export function JumpTo({
  onJump,
  oldest,
  open,
  setOpen,
  className,
}: {
  onJump: (t: number) => void;
  oldest?: number;
  open: boolean;
  setOpen: (o: boolean) => void;
  className?: string;
}) {
  const [text, setText] = useState("");
  const [picked, setPicked] = useState(() => toLocalInput(Date.now() - 3_600_000));
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  // Open towards whichever side has room.
  const [alignLeft, setAlignLeft] = useState(false);
  const t = text.trim() ? parseWhen(text) : null;
  const tooOld = t !== null && oldest !== undefined && t < oldest;

  useEffect(() => {
    if (!open) return;
    const r = box.current?.getBoundingClientRect();
    if (r) setAlignLeft(r.left + r.width / 2 < window.innerWidth / 2);
    setTimeout(() => input.current?.focus(), 30);
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open, setOpen]);

  const go = (when: number | null) => {
    if (when === null) return;
    onJump(Math.min(when, Date.now()));
    setOpen(false);
    setText("");
  };

  return (
    <div ref={box} className={clsx("relative", className)}>
      <button
        onClick={() => setOpen(!open)}
        title="Go to a date and time (G)"
        className={clsx(
          "flex h-9 items-center gap-2 rounded-xl border px-3 text-sm font-medium transition",
          open ? "border-violet-400/40 bg-violet-500/15 text-white" : "border-white/10 bg-white/5 text-slate-300 hover:bg-white/10 hover:text-white",
        )}
      >
        <CalendarClock className="size-4" /> Go to
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.15 }}
            className={clsx("absolute top-11 z-40", alignLeft ? "left-0" : "right-0", " w-[min(22rem,calc(100vw-2rem))] rounded-2xl border border-white/10 bg-ink-900/95 p-3 shadow-2xl shadow-black/60 backdrop-blur-xl")}
          >
            <div className="relative">
              <input
                ref={input}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") go(t);
                  if (e.key === "Escape") setOpen(false);
                  e.stopPropagation();
                }}
                placeholder="e.g. yesterday 3:15 pm"
                className="h-10 w-full rounded-xl border border-white/10 bg-ink-950 pl-3 pr-10 text-sm text-white placeholder:text-slate-600 focus:border-violet-400/50 focus:outline-none"
              />
              <button onClick={() => go(t)} disabled={t === null} className="absolute right-1.5 top-1.5 flex size-7 items-center justify-center rounded-lg bg-violet-500 text-white transition disabled:bg-white/5 disabled:text-slate-600">
                <CornerDownLeft className="size-3.5" />
              </button>
            </div>
            <div className={clsx("mt-2 min-h-5 px-1 text-xs", t === null ? "text-slate-500" : tooOld ? "text-amber-300" : "text-cyan-200")}>
              {text.trim() === ""
                ? "Try “22:40”, “mon 9am”, “27 sep 2pm” or “10 min ago”"
                : t === null
                  ? "Didn't understand that time"
                  : `→ ${fmtDay(t)} · ${fmtTimeSec(t)}${tooOld ? " (older than the kept footage)" : ""}`}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {QUICK.map(([label, q]) => (
                <button key={label} onClick={() => go(parseWhen(q))} className="rounded-full border border-white/10 px-2.5 py-1 text-xs text-slate-300 transition hover:border-white/20 hover:bg-white/5 hover:text-white">
                  {label}
                </button>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-2 border-t border-white/5 pt-3">
              <input
                type="datetime-local"
                step={1}
                value={picked}
                max={toLocalInput(Date.now())}
                onChange={(e) => setPicked(e.target.value)}
                className="h-9 min-w-0 flex-1 rounded-xl border border-white/10 bg-ink-950 px-2 text-sm text-white [color-scheme:dark]"
              />
              <button onClick={() => go(new Date(picked).getTime())} className="h-9 rounded-xl bg-white/10 px-3 text-sm font-medium text-white transition hover:bg-white/15">
                Go
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
