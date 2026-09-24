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

## Alexa announcements

Set `alexa_entities` (e.g. `media_player.living_room_echo`, from the Alexa Media
Player integration). When the internet drops, and again when it comes back, the
Echo is raised to `alexa_volume` (60%), speaks, and is put back to its previous
volume. The "back" message says how long the outage lasted.

**Alexa can't talk without internet.** Every Alexa announcement goes through
Amazon's servers, so during a full international outage nothing can make the Echo
speak. The add-on checks whether Amazon is still reachable first:

- reachable (partial outage): Alexa announces it as usual;
- not reachable: the warning is spoken by the phone in `offline_tts_service`
  instead (Home Assistant companion app text-to-speech, at full alarm volume, then
  restored). The phone receives it over your home Wi-Fi without internet **only if**
  the app's *Settings → Companion app → Persistent connection* is set to *Always*
  or *Home Wi-Fi only*.

Nothing is announced during `maintenance_windows` or `alexa_quiet_hours`.
The dashboard's *Alexa announcements* card has test buttons.

## WhatsApp outage report

When the internet comes back (after outages of at least `notify_min_outage_minutes`),
a formatted report is sent through the **PDC WhatsApp Bridge** add-on: when it went
down and came back, how long it lasted, the speed it came back with (bars vs your
plan), whether the line showed warning signs (loss / high ping) before it dropped,
today's and this week's outages and uptime, how it ranks against earlier outages,
the gap since the previous one, and a public IP / ISP change if there was one.

Set `whatsapp_to` to the bridge's `recipient_number` and `whatsapp_api_token` to
the bridge's `api_token`. The bridge is found automatically; set
`whatsapp_bridge_url` only if that fails. If WhatsApp is still reconnecting after
the outage, the report is retried for up to 30 minutes and never sent twice.
The dashboard shows a live preview and has a *Send test* button.

## Monthly ISP report

On the 1st of each month (from `monthly_report_hour`), last month's ISP report card
goes to WhatsApp: grade, average download / upload vs the plan you pay for, share of
tests that reached 80% of it or fell below half, ping, uptime, outages and total
downtime, the longest outage and worst day, fastest and slowest hour, and how it
compares with the month before. Set `plan_price` (your monthly bill) to add a
*value for money* line: price × (average speed vs plan) × uptime.

The dashboard's *Monthly ISP report* card lists every month with its grade; click one
to preview its report, or send it now.

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
| `alexa_entities` | none | Echo `media_player` entities that announce outages |
| `alexa_volume` | 60 | Volume (%) while announcing; restored afterwards |
| `alexa_down_message` / `alexa_up_message` | | `{duration}` = spoken outage length |
| `alexa_quiet_hours` | none | Daily `HH:MM-HH:MM` windows with no announcements |
| `offline_tts_service` | empty | Phone that speaks the warning when Alexa can't, e.g. `notify.mobile_app_my_phone` |
| `whatsapp_to` | empty | Your number, e.g. `+8801XXXXXXXXX` (must be the bridge's recipient) |
| `whatsapp_api_token` | empty | The PDC WhatsApp Bridge `api_token` |
| `whatsapp_bridge_url` | auto | Override, e.g. `http://172.30.33.6:8787` |
| `monthly_report_enabled` / `_hour` | on / 10 | Monthly ISP report on the 1st |
| `plan_price` / `plan_currency` | 0 / ৳ | Monthly bill for the value-for-money line (`0` = off) |

Data use: roughly 100 MB per speedtest at 40 Mbit/s (~2.4 GB/day hourly).
