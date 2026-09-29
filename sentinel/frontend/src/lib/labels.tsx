import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Cat, Dog, PersonStanding, Zap, type LucideIcon } from "lucide-react";
import { eventPicture, thumbURL, type Label, type SentinelEvent } from "./api";
import { whenNear } from "./lazy";

// How each kind of thing seen looks everywhere (lists, timelines, summary).
export const LABELS: Record<Label, { name: string; plural: string; icon: LucideIcon; color: string; chip: string }> = {
  person: { name: "Person", plural: "People", icon: PersonStanding, color: "#db2777", chip: "bg-pink-600 text-white" },
  cat: { name: "Cat", plural: "Cats", icon: Cat, color: "#65a30d", chip: "bg-lime-600 text-white" },
  dog: { name: "Dog", plural: "Dogs", icon: Dog, color: "#2563eb", chip: "bg-blue-600 text-white" },
};
// Plain motion, in charts (validated with the three above on the dark surface).
export const MOTION_COLOR = "#d97706";
export const LABEL_ORDER: Label[] = ["person", "cat", "dog"];

// The most important label of an event (people first), if any.
export const mainLabel = (e: SentinelEvent): Label | undefined => LABEL_ORDER.find((l) => e.labels?.includes(l));

// Small badges for an event's labels ("Motion" when checked and nobody was seen).
export function LabelChips({ e, size = "sm", showMotion = false, onWrong }: { e: SentinelEvent; size?: "xs" | "sm"; showMotion?: boolean; onWrong?: (l: Label) => void }) {
  const labels = LABEL_ORDER.filter((l) => e.labels?.includes(l));
  if (labels.length === 0) {
    if (!showMotion) return null;
    return (
      <span className={clsx("inline-flex items-center gap-1 rounded-md bg-black/55 font-semibold text-amber-200 backdrop-blur-sm", size === "xs" ? "px-1 py-0.5 text-[9px]" : "px-1.5 py-0.5 text-[10px]")}>
        <Zap className={size === "xs" ? "size-2.5" : "size-3"} /> {e.scan === "done" || e.scan === "none" ? "Motion" : "Checking…"}
      </span>
    );
  }
  return (
    <span className="inline-flex gap-1">
      {labels.map((l) => {
        const L = LABELS[l];
        return (
          <span key={l} className={clsx("group/chip inline-flex items-center gap-1 rounded-md font-bold shadow-sm", L.chip, size === "xs" ? "px-1 py-0.5 text-[9px]" : "px-1.5 py-0.5 text-[10px]")}>
            <L.icon className={size === "xs" ? "size-2.5" : "size-3"} /> {L.name}
            {onWrong && (
              <span
                role="button"
                tabIndex={0}
                title={`Not a ${L.name.toLowerCase()}? Remove this label (Sentinel learns from it)`}
                onClick={(ev) => {
                  ev.stopPropagation();
                  onWrong(l);
                }}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter") {
                    ev.stopPropagation();
                    onWrong(l);
                  }
                }}
                className="-mr-0.5 ml-0.5 hidden rounded bg-black/25 px-1 hover:bg-black/50 group-hover/chip:inline"
              >
                ✕
              </span>
            )}
          </span>
        );
      })}
    </span>
  );
}

// The event's picture; a snapshot of someone seen gets a frame around them. Loaded (small)
// only when near the screen, faded in, and cancelled if it leaves the page first, so a
// long list never holds up the video opened from it.
export function EventPicture({ e, className, boxes = true }: { e: SentinelEvent; className?: string; boxes?: boolean }) {
  const src = eventPicture(e, true);
  const holder = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement | null>(null);
  const [near, setNear] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const shown = e.snap && boxes ? (e.objects ?? []).filter((o) => o.t === e.objects?.[0]?.t) : [];

  useEffect(() => (near || !holder.current ? undefined : whenNear(holder.current, () => setNear(true))), [near]);
  // Leaving the page stops a download still under way.
  useEffect(() => () => img.current?.removeAttribute("src"), []);

  return (
    <div ref={holder} className={clsx("relative overflow-hidden bg-ink-800", className)}>
      {src ? (
        near && (
          <img
            ref={(el) => {
              if (el) img.current = el;
            }}
            src={src}
            decoding="async"
            alt=""
            onLoad={() => setLoaded(true)}
            className={clsx("h-full w-full object-cover transition-opacity duration-300", loaded ? "opacity-100" : "opacity-0")}
            // A missing snapshot falls back to the moment motion started.
            onError={(ev) => {
              const el = ev.currentTarget;
              if (e.thumb && !el.src.includes("thumb.jpg")) el.src = thumbURL(e, true);
              else el.style.visibility = "hidden";
            }}
          />
        )
      ) : (
        <Zap className="absolute inset-0 m-auto size-5 text-slate-600" />
      )}
      {loaded &&
        shown.map((o) => (
          <div
            key={o.label}
            className="pointer-events-none absolute rounded-[3px] border-2"
            style={{ left: `${o.box.x * 100}%`, top: `${o.box.y * 100}%`, width: `${o.box.w * 100}%`, height: `${o.box.h * 100}%`, borderColor: LABELS[o.label].color, boxShadow: `0 0 10px ${LABELS[o.label].color}80` }}
          />
        ))}
    </div>
  );
}

// Suggested searches, shown under the search box.
export const SEARCH_EXAMPLES = ["People today", "Person last night", "Cats this week", "Dogs yesterday", "People after 10pm", "Animals this morning"];
