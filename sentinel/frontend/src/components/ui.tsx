import clsx from "clsx";
import { motion, type HTMLMotionProps } from "motion/react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { RecStatus } from "../lib/api";

export function Card({ className, children, ...rest }: HTMLMotionProps<"div">) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      className={clsx("glass rounded-2xl", className)}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "subtle" | "danger"; size?: "sm" | "md" };

export function Button({ variant = "subtle", size = "md", className, children, ...rest }: BtnProps) {
  return (
    <button
      className={clsx(
        "inline-flex select-none items-center justify-center gap-2 rounded-xl font-medium transition-all duration-200 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40",
        size === "sm" ? "h-8 px-3 text-xs" : "h-10 px-4 text-sm",
        variant === "primary" &&
          "bg-gradient-to-r from-violet-500 to-cyan-500 text-white shadow-lg shadow-violet-500/20 hover:shadow-violet-500/40 hover:brightness-110",
        variant === "subtle" && "border border-white/10 bg-white/[0.04] text-slate-200 hover:border-white/20 hover:bg-white/[0.08]",
        variant === "ghost" && "text-slate-300 hover:bg-white/[0.06] hover:text-white",
        variant === "danger" && "border border-rose-500/30 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function IconButton({ className, children, title, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      title={title}
      aria-label={title}
      className={clsx(
        "inline-flex size-9 items-center justify-center rounded-xl text-slate-300 transition-all hover:bg-white/10 hover:text-white active:scale-90 disabled:opacity-40",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 py-1">
      {label && (
        <span className="min-w-0">
          <span className="block text-sm text-slate-200">{label}</span>
          {hint && <span className="block text-xs text-slate-500">{hint}</span>}
        </span>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={clsx(
          "relative h-6 w-11 shrink-0 rounded-full transition-colors duration-300",
          checked ? "bg-gradient-to-r from-violet-500 to-cyan-500" : "bg-ink-600",
        )}
      >
        <motion.span
          layout
          transition={{ type: "spring", stiffness: 600, damping: 32 }}
          className={clsx("absolute top-0.5 size-5 rounded-full bg-white shadow", checked ? "right-0.5" : "left-0.5")}
        />
      </button>
    </label>
  );
}

export const STATE_META: Record<string, { label: string; dot: string; text: string; bg: string }> = {
  recording: { label: "Recording", dot: "bg-rose-500", text: "text-rose-300", bg: "bg-rose-500/10 border-rose-500/25" },
  starting: { label: "Connecting", dot: "bg-sky-400", text: "text-sky-300", bg: "bg-sky-500/10 border-sky-500/25" },
  stalled: { label: "Stalled", dot: "bg-amber-400", text: "text-amber-300", bg: "bg-amber-500/10 border-amber-500/25" },
  reconnecting: { label: "Reconnecting", dot: "bg-amber-400", text: "text-amber-300", bg: "bg-amber-500/10 border-amber-500/25" },
  offline: { label: "Offline", dot: "bg-slate-500", text: "text-slate-300", bg: "bg-slate-500/10 border-slate-500/25" },
  disabled: { label: "Disabled", dot: "bg-slate-600", text: "text-slate-400", bg: "bg-slate-500/10 border-slate-500/20" },
  "not-recording": { label: "Live only", dot: "bg-slate-500", text: "text-slate-300", bg: "bg-slate-500/10 border-slate-500/20" },
};

export function recState(enabled: boolean, record: boolean, rec: RecStatus | null) {
  if (!enabled) return "disabled";
  if (!record) return "not-recording";
  return rec?.state ?? "starting";
}

export function StatePill({ state, compact }: { state: string; compact?: boolean }) {
  const m = STATE_META[state] ?? STATE_META.offline;
  return (
    <span className={clsx("inline-flex items-center gap-1.5 rounded-full border font-semibold tracking-wide", m.bg, m.text, compact ? "px-2 py-0.5 text-[10px] uppercase" : "px-2.5 py-1 text-xs")}>
      <span className={clsx("size-1.5 rounded-full", m.dot, state === "recording" && "animate-pulse-dot")} />
      {compact && state === "recording" ? "REC" : m.label}
    </span>
  );
}

export function SectionTitle({ children, action, sub }: { children: ReactNode; action?: ReactNode; sub?: ReactNode }) {
  return (
    <div className="mb-3 flex items-end justify-between gap-3">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">{children}</h2>
        {sub && <p className="mt-0.5 text-xs text-slate-500">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

export function PageHeader({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">{title}</h1>
        {sub && <p className="mt-1 text-sm text-slate-400">{sub}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Stat({ label, value, sub, accent }: { label: string; value: ReactNode; sub?: ReactNode; accent?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs font-medium uppercase tracking-wider text-slate-500">{label}</div>
      <div className={clsx("mt-1 truncate text-xl font-semibold tabular-nums", accent ?? "text-white")}>{value}</div>
      {sub && <div className="mt-0.5 truncate text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-slate-400">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export const inputCls =
  "h-10 w-full rounded-xl border border-white/10 bg-ink-900/80 px-3 text-sm text-white placeholder:text-slate-600 outline-none transition focus:border-violet-400/60 focus:ring-2 focus:ring-violet-500/20";

export function Empty({ icon, title, sub, action }: { icon: ReactNode; title: string; sub?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <div className="flex size-14 items-center justify-center rounded-2xl bg-white/[0.04] text-slate-400">{icon}</div>
      <div className="font-medium text-slate-200">{title}</div>
      {sub && <div className="max-w-sm text-sm text-slate-500">{sub}</div>}
      {action}
    </div>
  );
}
