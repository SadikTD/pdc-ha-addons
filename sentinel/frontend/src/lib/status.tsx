import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type Status } from "./api";

type Ctx = { status: Status | null; error: string | null; refresh: () => void };
const StatusContext = createContext<Ctx>({ status: null, error: null, refresh: () => {} });

// One shared poll for the whole app; pauses while the tab is hidden.
export function StatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number>(0);
  const inFlight = useRef(false);
  const stopped = useRef(false);

  const again = useRef(false);

  // One request at a time, so extra refreshes (tab shown again, after saving) never start a
  // second polling loop. A refresh during a request runs once more right after it, so it
  // still sees the latest state.
  const load = useCallback(async () => {
    if (stopped.current) return;
    if (inFlight.current) {
      again.current = true;
      return;
    }
    inFlight.current = true;
    again.current = false;
    window.clearTimeout(timer.current);
    try {
      setStatus(await api.status());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      inFlight.current = false;
    }
    window.clearTimeout(timer.current);
    if (stopped.current) return;
    timer.current = window.setTimeout(load, again.current ? 0 : document.hidden ? 15_000 : 2_500);
  }, []);

  useEffect(() => {
    stopped.current = false;
    load();
    const onVis = () => !document.hidden && load();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stopped.current = true;
      window.clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load]);

  const value = useMemo(() => ({ status, error, refresh: load }), [status, error, load]);
  return <StatusContext.Provider value={value}>{children}</StatusContext.Provider>;
}

export const useStatus = () => useContext(StatusContext);
