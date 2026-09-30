import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { Check, Plus, UserRound } from "lucide-react";
import { faceURL, type PersonInfo } from "../lib/api";

export type Pick = { person?: string; name?: string; label: string };

// Type a name: pick someone Sentinel knows (with their picture), or add a new person.
// Arrow keys + Enter work; the first match is highlighted.
export function NamePicker({
  people,
  onPick,
  placeholder = "Who is this?",
  disabled,
  autoFocus,
  className,
  dropUp,
}: {
  people: PersonInfo[];
  onPick: (p: Pick) => void;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
  dropUp?: boolean;
}) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // The list is drawn above everything (cards animate and would cover it), next to the
  // input: below it, or above when there's more room there.
  const [pos, setPos] = useState<{ left: number; width: number; top?: number; bottom?: number } | null>(null);
  const q = text.trim().toLowerCase();
  const matches = useMemo(() => people.filter((p) => !q || p.name.toLowerCase().includes(q)).slice(0, 8), [people, q]);
  const exact = people.some((p) => p.name.toLowerCase() === q);
  const options: Pick[] = [...matches.map((p) => ({ person: p.id, label: p.name })), ...(q && !exact ? [{ name: text.trim(), label: text.trim() }] : [])];

  useEffect(() => setHi(0), [q]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = box.current?.getBoundingClientRect();
      if (!r) return;
      const up = dropUp ?? (window.innerHeight - r.bottom < 300 && r.top > window.innerHeight - r.bottom);
      setPos(up ? { left: r.left, width: r.width, bottom: window.innerHeight - r.top + 4 } : { left: r.left, width: r.width, top: r.bottom + 4 });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, dropUp]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => !box.current?.contains(e.target as Node) && !list.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const pick = (p: Pick) => {
    onPick(p);
    setText("");
    setOpen(false);
  };

  return (
    <div ref={box} className={clsx("relative", className)}>
      <div className={clsx("flex h-10 items-center gap-2 rounded-xl border bg-ink-950/80 px-3 transition", open ? "border-violet-400/50" : "border-white/10")}>
        <UserRound className="size-4 shrink-0 text-slate-500" />
        <input
          value={text}
          disabled={disabled}
          autoFocus={autoFocus}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") (e.preventDefault(), setHi((h) => Math.min(h + 1, options.length - 1)));
            else if (e.key === "ArrowUp") (e.preventDefault(), setHi((h) => Math.max(h - 1, 0)));
            else if (e.key === "Enter" && options[hi]) (e.preventDefault(), pick(options[hi]));
            else if (e.key === "Escape" && open && options.length > 0) (e.stopPropagation(), setOpen(false));
            if (e.key !== "Escape") e.stopPropagation();
          }}
          placeholder={placeholder}
          className="min-w-0 flex-1 bg-transparent text-sm text-white placeholder:text-slate-500 focus:outline-none"
        />
      </div>
      {open &&
        options.length > 0 &&
        pos &&
        createPortal(
        <div
          ref={list}
          style={{ position: "fixed", left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom }}
          className="z-[100] max-h-72 overflow-y-auto rounded-xl border border-white/10 bg-ink-900 py-1 shadow-2xl shadow-black/60"
        >
          {options.map((o, i) => {
            const p = people.find((x) => x.id === o.person);
            return (
              <button
                key={o.person ?? "new"}
                type="button"
                onMouseEnter={() => setHi(i)}
                onClick={() => pick(o)}
                className={clsx("flex w-full items-center gap-3 px-3 py-2 text-left text-sm", i === hi ? "bg-white/10 text-white" : "text-slate-300")}
              >
                {p ? (
                  p.cover ? (
                    <img src={faceURL(p.cover)} alt="" className="size-7 rounded-full object-cover" />
                  ) : (
                    <UserRound className="size-7 rounded-full bg-white/5 p-1.5 text-slate-400" />
                  )
                ) : (
                  <Plus className="size-7 rounded-full bg-violet-500/20 p-1.5 text-violet-300" />
                )}
                <span className="flex-1 truncate">{p ? o.label : <>Add “{o.label}” as a new person</>}</span>
                {i === hi && <Check className="size-4 text-violet-300" />}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
