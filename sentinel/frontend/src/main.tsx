import { StrictMode, Suspense, lazy, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, Route, Routes } from "react-router-dom";
import "./index.css";
import { StatusProvider } from "./lib/status";
import { ToastProvider } from "./lib/toast";
import { Shell } from "./components/Shell";
import { LivePage } from "./pages/Live";

// Everything but the Live page loads when first opened, so the app starts quickly (the
// players, settings and QR code are most of the code).
const named = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) =>
  lazy(() => load().then((m) => ({ default: m[name] })));
const CameraPage = named(() => import("./pages/Camera"), "CameraPage");
const TimelinePage = named(() => import("./pages/TimelinePage"), "TimelinePage");
const EventsPage = named(() => import("./pages/Events"), "EventsPage");
const SummaryPage = named(() => import("./pages/Summary"), "SummaryPage");
const ClipsPage = named(() => import("./pages/Clips"), "ClipsPage");
const SystemPage = named(() => import("./pages/System"), "SystemPage");
const SettingsPage = named(() => import("./pages/Settings"), "SettingsPage");
const PlaybackPage = named(() => import("./pages/Playback"), "PlaybackPage");
const EmbedPage = named(() => import("./pages/Embed"), "EmbedPage");

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
                <Suspense fallback={null}>
                  <EmbedPage />
                </Suspense>
              }
            />
            <Route
              path="*"
              element={
                <Shell>
                  <Suspense fallback={loading}>
                  <Routes>
                    <Route path="/" element={<LivePage />} />
                    <Route path="/camera/:id" element={<CameraPage />} />
                    <Route path="/playback" element={<PlaybackPage />} />
                    <Route path="/timeline" element={<TimelinePage />} />
                    <Route path="/events" element={<EventsPage />} />
                    <Route path="/summary" element={<SummaryPage />} />
                    <Route path="/clips" element={<ClipsPage />} />
                    <Route path="/system" element={<SystemPage />} />
                    <Route path="/settings" element={<SettingsPage />} />
                  </Routes>
                  </Suspense>
                </Shell>
              }
            />
          </Routes>
        </ToastProvider>
      </StatusProvider>
    </HashRouter>
  </StrictMode>,
);
