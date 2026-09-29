import { Component, StrictMode, Suspense, lazy, type ComponentType, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, Route, Routes, useLocation } from "react-router-dom";
import "./index.css";
import { StatusProvider } from "./lib/status";
import { ToastProvider } from "./lib/toast";
import { Shell } from "./components/Shell";
import { LivePage } from "./pages/Live";

// Everything but the Live page loads separately, so the app starts quickly (the players,
// settings and QR code are most of the code); the rest loads in the background right
// after, so opening a page never waits.
const loaders: (() => Promise<unknown>)[] = [];
const named = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) => {
  loaders.push(load);
  return lazy(() => loadPage(load).then((m) => ({ default: m[name] })));
};

// A page's code can fail to load: a moment of bad connection (try again), or Sentinel was
// updated since this tab opened and the old files are gone (reload the app, once).
async function loadPage<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch {
    await new Promise((r) => setTimeout(r, 800));
    try {
      return await load();
    } catch (e) {
      if (!sessionStorage.getItem("sentinel.reloaded")) {
        sessionStorage.setItem("sentinel.reloaded", "1");
        location.reload();
        await new Promise(() => {}); // wait for the reload
      }
      throw e;
    }
  }
}
window.addEventListener("load", () => {
  sessionStorage.removeItem("sentinel.reloaded");
  const idle = window.requestIdleCallback ?? ((f: () => void) => setTimeout(f, 1500));
  idle(() => loaders.forEach((l) => l().catch(() => {})));
});

const CameraPage = named(() => import("./pages/Camera"), "CameraPage");
const TimelinePage = named(() => import("./pages/TimelinePage"), "TimelinePage");
const EventsPage = named(() => import("./pages/Events"), "EventsPage");
const SummaryPage = named(() => import("./pages/Summary"), "SummaryPage");
const PeoplePage = named(() => import("./pages/People"), "PeoplePage");
const ClipsPage = named(() => import("./pages/Clips"), "ClipsPage");
const SystemPage = named(() => import("./pages/System"), "SystemPage");
const SettingsPage = named(() => import("./pages/Settings"), "SettingsPage");
const PlaybackPage = named(() => import("./pages/Playback"), "PlaybackPage");
const EmbedPage = named(() => import("./pages/Embed"), "EmbedPage");

// Never a blank page: if something breaks, say so and offer to reload.
class PageError extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
        <div className="text-lg font-semibold text-white">This page couldn't be shown</div>
        <div className="max-w-md text-sm text-slate-400">{this.state.error.message || "Something went wrong."}</div>
        <button onClick={() => location.reload()} className="mt-2 rounded-xl bg-violet-500 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-400">
          Reload Sentinel
        </button>
      </div>
    );
  }
}

// A fresh error boundary per page, so one page's problem doesn't stick to the next.
function RoutePageError({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return <PageError key={pathname}>{children}</PageError>;
}

const loading = (
  <div className="flex min-h-[40vh] items-center justify-center">
    <div className="size-6 animate-spin rounded-full border-2 border-white/15 border-t-violet-400" />
  </div>
);

// Hash routing: ingress serves the app under a path prefix we don't control.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HashRouter>
      <StatusProvider>
        <ToastProvider>
          <Routes>
            {/* Home Assistant dashboard card: no navigation chrome. */}
            <Route
              path="/embed"
              element={
                <PageError>
                  <Suspense fallback={null}>
                    <EmbedPage />
                  </Suspense>
                </PageError>
              }
            />
            <Route
              path="*"
              element={
                <Shell>
                  <RoutePageError>
                  <Suspense fallback={loading}>
                  <Routes>
                    <Route path="/" element={<LivePage />} />
                    <Route path="/camera/:id" element={<CameraPage />} />
                    <Route path="/playback" element={<PlaybackPage />} />
                    <Route path="/timeline" element={<TimelinePage />} />
                    <Route path="/events" element={<EventsPage />} />
                    <Route path="/summary" element={<SummaryPage />} />
                    <Route path="/people" element={<PeoplePage />} />
                    <Route path="/clips" element={<ClipsPage />} />
                    <Route path="/system" element={<SystemPage />} />
                    <Route path="/settings" element={<SettingsPage />} />
                  </Routes>
                  </Suspense>
                  </RoutePageError>
                </Shell>
              }
            />
          </Routes>
        </ToastProvider>
      </StatusProvider>
    </HashRouter>
  </StrictMode>,
);
