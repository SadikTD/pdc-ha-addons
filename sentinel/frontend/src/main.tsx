import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, Route, Routes } from "react-router-dom";
import "./index.css";
import { StatusProvider } from "./lib/status";
import { ToastProvider } from "./lib/toast";
import { Shell } from "./components/Shell";
import { LivePage } from "./pages/Live";
import { CameraPage } from "./pages/Camera";
import { TimelinePage } from "./pages/TimelinePage";
import { EventsPage } from "./pages/Events";
import { SystemPage } from "./pages/System";
import { SettingsPage } from "./pages/Settings";

// Hash routing: ingress serves the app under a path prefix we don't control.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HashRouter>
      <StatusProvider>
        <ToastProvider>
          <Shell>
            <Routes>
              <Route path="/" element={<LivePage />} />
              <Route path="/camera/:id" element={<CameraPage />} />
              <Route path="/timeline" element={<TimelinePage />} />
              <Route path="/events" element={<EventsPage />} />
              <Route path="/system" element={<SystemPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Routes>
          </Shell>
        </ToastProvider>
      </StatusProvider>
    </HashRouter>
  </StrictMode>,
);
