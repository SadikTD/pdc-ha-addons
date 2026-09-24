# PDC Home Assistant add-ons

## PDC WhatsApp Bridge

Self-hosted [Baileys](https://github.com/WhiskeySockets/Baileys) sender used by the Pitch Duplicate Checker Worker.

- Logs in once with a pairing code shown in the add-on log.
- Exposes `POST /send` (bearer token, JSON `{to, text, idempotencyKey}`) and `GET /health` on port 8787 inside the Supervisor network only. No host port is published.
- Only the configured recipient number can be messaged.
- Each idempotency key is sent at most once, including across restarts.
- Session files are written atomically (temp file, fsync, rename), so a power cut can't corrupt the login.
- Raises a Home Assistant notification if WhatsApp is unlinked, restricted, or offline for 10+ minutes.

Configure `api_token` (32+ random characters), `sender_number` and `recipient_number` in the add-on options before starting.

Tests: `node --test bridge.test.mjs` (no dependencies) and, after `npm install`, `node --test auth-state.test.mjs`.

## Net Monitor

Tracks the **international** internet connection (not BDIX / in-country caches).

- Checks every 30 s against Singapore hosts; records each outage as *from → to, duration* and the speed the line came back with.
- Hourly Ookla speedtest to a Singapore server, on the hour. Waits while the router (read over UPnP) shows the line is busy, and can be paused from the dashboard.
- Dashboard in the Home Assistant sidebar: speed chart with outages shaded, "what was my internet like at…" lookup, outage and speedtest tables, CSV export.
- Publishes `binary_sensor.net_monitor_internet` and download / upload / ping sensors; optional phone notification when the internet comes back.

See [net_monitor/DOCS.md](net_monitor/DOCS.md) for options.
