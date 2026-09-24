# Net Monitor

Tracks your **international** internet connection (not BDIX / local caches).

## What it does

- **Outages.** Every 30 s it TCP-connects to a few Singapore hosts and Cloudflare.
  Two failed rounds in a row = outage, dated from the first failure. Each outage
  is listed as *from → to, duration* with the speed the line came back with.
- **Connection quality.** Each check also takes a few extra handshakes to the
  fastest target to measure latency, jitter and packet loss (a few hundred bytes).
- **Speed.** Every hour on the hour it runs the official Ookla Speedtest CLI
  against well-routed Singapore servers, with live progress on the dashboard.
- **Busy-line guard.** Before a scheduled test it reads the router's WAN counters
  over UPnP for 8 s (Home Assistant isn't involved). The line counts as busy if
  download exceeds `busy_threshold_mbps` (downloads, streaming), upload exceeds
  `busy_upload_mbps`, or outgoing packets exceed `busy_packets_per_second` —
  the last two catch gaming and calls, which use little bandwidth but send a
  steady packet stream. It then waits `busy_retry_minutes` and retries, skipping
  the hour only if the line stays busy. Manual tests always run.
- **Scheduled router restarts.** Outages inside a `maintenance_windows` entry
  (e.g. `02:58-03:10` for a nightly 3 AM reboot) are logged as *Scheduled router
  restart*: excluded from uptime, no notification, no recovery speedtest. If the
  internet is still down when the window ends, the rest counts as a real outage.
  A scheduled speedtest that falls in the window runs after it instead.
- **Power cuts.** Time when the add-on wasn't running shows as *Not monitored* and
  counts as neither uptime nor downtime.

## Dashboard

Open **Net Monitor** in the Home Assistant sidebar (enable *Show in sidebar* on the
add-on page). It follows Home Assistant's light/dark theme.

- Live status: online-for counter, latency / jitter / loss, 30-minute latency sparkline.
- Latest speed as a share of your plan, and a live progress readout during tests.
- Uptime strip for the selected range (hover a bar for details).
- Report card: A–F grade (60% speed vs plan, 40% uptime), averages, share of tests
  below half of plan, longest outage, slowest and fastest hour of day.
- Speed chart with your plan as a dashed line. Drag to zoom, double-click to reset.
- Connection quality chart (latency, jitter, packet loss).
- Best & worst times heatmap: average download by weekday × hour, last 30 days.
- "What was my internet like at…" lookup, ISP / public IP history, outage and
  speedtest tables with CSV export.

## Notifications (`notify_service`)

- Internet is back after an outage (with the recovery speed).
- Slow speed: `slow_alert_consecutive_tests` tests in a row below
  `slow_alert_percent` of your plan, then a message when it recovers.
- Weekly report on `weekly_report_day` at `weekly_report_hour`.

## Home Assistant entities

| Entity | Meaning |
|---|---|
| `binary_sensor.net_monitor_internet` | `on` = international internet reachable (attributes: latency, jitter, loss, online/offline since, `planned_outage` = down only because of a scheduled restart) |
| `sensor.net_monitor_download` / `_upload` / `_ping` | last speedtest |
| `sensor.net_monitor_download_plan` | last download as % of plan |
| `sensor.net_monitor_uptime_24h` | uptime over the last 24 h |
| `sensor.net_monitor_jitter` / `_packet_loss` | latest connection quality |
| `sensor.net_monitor_last_outage` | when the last outage ended (attributes: start, duration) |

## Options

| Option | Default | |
|---|---|---|
| `plan_download_mbps` / `plan_upload_mbps` | 40 / 40 | Your ISP plan |
| `speedtest_interval_minutes` | 60 | Aligned to local midnight, so 60 = on the hour |
| `server_ids` | Singapore servers | Ookla server IDs, tried in order |
| `check_interval_seconds` | 30 | Connectivity check period |
| `check_targets` | Singapore + 1.1.1.1 | `host:port`; online if **any** answers |
| `quality_samples` | 5 | Handshakes per check for jitter / loss |
| `busy_threshold_mbps` | 5 | Download Mbps that counts as busy (`0` = ignore) |
| `busy_upload_mbps` | 0.25 | Upload Mbps that counts as busy (`0` = ignore) |
| `busy_packets_per_second` | 40 | Outgoing packets/s that count as busy (`0` = ignore) |
| `busy_retry_minutes` | 10 | |
| `recovery_speedtest_min_outage_minutes` | 2 | Speedtest after outages at least this long |
| `notify_service` | empty | e.g. `notify.mobile_app_my_phone` |
| `notify_min_outage_minutes` | 1 | Don't notify for shorter blips |
| `slow_alert_percent` | 50 | `0` disables slow-speed alerts |
| `slow_alert_consecutive_tests` | 2 | |
| `weekly_report_enabled` / `_day` / `_hour` | on / sun / 21 | |
| `maintenance_windows` | none | Daily `HH:MM-HH:MM` windows for scheduled router restarts |
| `retention_days` | 365 | |

Data use: roughly 100 MB per speedtest at 40 Mbit/s (~2.4 GB/day hourly).
