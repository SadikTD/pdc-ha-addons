# PDC Home Assistant add-ons

## Sentinel

Reliable 24/7 camera recorder (NVR) with a modern UI, built to keep recording through router restarts and power cuts.

- Records each camera's main stream without re-encoding into 1-minute, power-cut-safe MP4 files. A watchdog restarts any stream that stalls for 20 s and retries dropped cameras forever.
- Corrects timestamps itself when the host clock is wrong (e.g. after a power cut with the internet down); file names are unique, so nothing is ever overwritten.
- Sidebar app: live grid, full-quality live view, zoomable recordings timeline with motion heatmap, events with thumbnails, clip export, system health and storage forecast, and a Settings page to add or edit any number of cameras.
- Motion detection on the substream, with ignore zones; MQTT motion/recording sensors and snapshot cameras; outage alerts with quiet windows.
- Synchronized multi-camera playback, "go to" any moment in plain words ("yesterday 3:15 pm"), event search by camera and time range.
- Night alerts: WhatsApp pictures (close-up of the moving area plus the full scene) through the PDC WhatsApp Bridge; optional clip of each alert.
- Keeps motion footage longer than 24/7 footage (e.g. 2 days of everything, 7 days of motion); clips backed up to Google Drive.
- A Lovelace card (`custom:sentinel-card`) with the live grid and latest motion.

See [sentinel/DOCS.md](sentinel/DOCS.md). UI source is in `sentinel/frontend` (`npm run build` writes `sentinel/www`).

## Sentinel app (Android)

A dedicated Android app for Sentinel: live cameras, the scrubbing timeline, events and clips, at home or from anywhere, connecting **directly** to Sentinel (QUIC with NAT hole punching, end-to-end encrypted, no port forwarding or VPN). Per-user logins managed under Sentinel → Settings → Sentinel app. Download the APK from the [releases](https://github.com/SadikTD/pdc-ha-addons/releases/latest); see [sentinel-app/README.md](sentinel-app/README.md).

## PDC WhatsApp Bridge

Self-hosted [Baileys](https://github.com/WhiskeySockets/Baileys) sender used by the Pitch Duplicate Checker Worker.

- Logs in once with a pairing code shown in the add-on log.
- Exposes `POST /send` (bearer token, JSON `{to, text, idempotencyKey}`) and `GET /health` on port 8787 inside the Supervisor network only. No host port is published.
- Only the configured recipient number can be messaged; `POST /send-image` (JPEG + caption, used by Sentinel's night alerts) may also go to WhatsApp groups the sender number is a member of (`GET /chats` lists them).
- Each idempotency key is sent at most once, including across restarts.
- Session files are written atomically (temp file, fsync, rename), so a power cut can't corrupt the login.
- Raises a Home Assistant notification if WhatsApp is unlinked, restricted, or offline for 10+ minutes.

- **PDC Monitor** in the Home Assistant sidebar (Ingress):
  - **Overview:** live scan heartbeat, checks per day by verdict, verdict mix, system health, scan history and when pitches are created.
  - **Pitches:** every checked pitch, searchable and filterable (duplicate, similar story, possible overlap, clear, waiting, problems). Each one opens a side-by-side comparison with its match, confidence, the AI's reason, a timeline, and the exact WhatsApp message. You can recheck a pitch or resend its alert.
  - **Messages:** everything the bridge sent (pitch alerts, monitor health, Net Monitor, tests) in a WhatsApp-style view.
  - **Activity:** scan history and a log of connection events, pairing codes and setting changes.
  - **Settings:** the WhatsApp link (pairing code shown in the UI, test message, relink); monitor on/off, live vs dry run, watched lists, which verdicts alert, minimum confidence, quiet hours, health alerts and reference window; and this add-on's options.

Configure `api_token` (32+ random characters), `sender_number` and `recipient_number` in the add-on options before starting. For the dashboard, set `worker_url` to the pitch-checker Worker's address. The dashboard reads the Worker's token-protected `/bridge/*` API with the same `api_token`, so the Worker's `BAILEYS_TOKEN` must equal it (as it already does for sending). Pitch checks and monitor settings live in the Worker's D1 database; message history and the event log stay in this add-on's `/data`.

Tests: `node --test bridge.test.mjs ui.test.mjs` (no dependencies) and, after `npm install`, `node --test auth-state.test.mjs`.

## Net Monitor

Tracks the **international** internet connection (not BDIX / in-country caches).

- Checks every 30 s against Singapore hosts (latency, jitter, packet loss); records each outage as *from → to, duration* and the speed the line came back with.
- Hourly Ookla speedtest to well-routed Singapore servers, with live progress. Waits while the router (read over UPnP) shows the line is busy; can be paused.
- Dashboard in the Home Assistant sidebar, with a Settings page for every option: live status, uptime strip, A–F report card vs your plan, zoomable speed chart, best/worst-times heatmap, "what was my internet like at…" lookup, ISP/IP history, CSV export.
- Sensors for speed, % of plan, uptime, jitter, loss and last outage; phone notifications for recovery, slow speed and a weekly report.
- Alexa announces when the internet drops and returns (60% volume, then restored; phone fallback when Amazon is unreachable), and a detailed outage report arrives on WhatsApp via the PDC WhatsApp Bridge, plus a monthly ISP report card (speed vs what you pay for, uptime, outages).

See [net_monitor/DOCS.md](net_monitor/DOCS.md) for options.
