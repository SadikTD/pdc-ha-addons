import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CheckCircle2, AlertTriangle, Info } from "lucide-react";

type Kind = "success" | "error" | "info";
type Action = { label: string; onClick: () => void };
type Toast = { id: number; kind: Kind; text: string; action?: Action };
const ToastContext = createContext<(text: string, kind?: Kind, action?: Action) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Kind = "success", action?: Action) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, text, action }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" || action ? 7000 : 3500);
  }, []);
  const Icon = { success: CheckCircle2, error: AlertTriangle, info: Info };
  const color = { success: "text-emerald-400", error: "text-rose-400", info: "text-cyan-300" };
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[100] flex flex-col items-center gap-2 px-4 md:bottom-6">
        <AnimatePresence>
          {toasts.map((t) => {
            const I = Icon[t.kind];
            return (
              <motion.div
                key={t.id}
                layout
                initial={{ opacity: 0, y: 16, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.96 }}
                className="glass pointer-events-auto flex max-w-md items-center gap-3 rounded-xl bg-ink-850/90 px-4 py-3 text-sm shadow-2xl shadow-black/50"
              >
                <I className={`size-4 shrink-0 ${color[t.kind]}`} />
                <span>{t.text}</span>
                {t.action && (
                  <button
                    onClick={() => {
                      t.action!.onClick();
                      setToasts((all) => all.filter((x) => x.id !== t.id));
                    }}
                    className="ml-1 shrink-0 rounded-lg bg-white/10 px-2.5 py-1 text-xs font-semibold text-white hover:bg-white/20"
                  >
                    {t.action.label}
                  </button>
                )}
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
