import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, type Status } from "./api";

type Ctx = { status: Status | null; error: string | null; refresh: () => void };
const StatusContext = createContext<Ctx>({ status: null, error: null, refresh: () => {} });

// One shared poll for the whole app; pauses while the tab is hidden.
export function StatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number>(0);

  const load = async () => {
    window.clearTimeout(timer.current);
    try {
      setStatus(await api.status());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
    timer.current = window.setTimeout(load, document.hidden ? 15_000 : 2_500);
  };

  useEffect(() => {
    load();
    const onVis = () => !document.hidden && load();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <StatusContext.Provider value={{ status, error, refresh: load }}>{children}</StatusContext.Provider>;
}

export const useStatus = () => useContext(StatusContext);
