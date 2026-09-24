# Net Monitor

Tracks your **international** internet connection (not BDIX / local caches):

- **Outages** – every 30 s it TCP-connects to a few Singapore hosts and Cloudflare.
  Two failed rounds in a row = outage, dated from the first failure. The dashboard
  lists each one as *from → to, duration* and the speed the line came back with.
- **Speed** – every hour on the hour it runs the official Ookla Speedtest CLI
  against a Singapore server (Singtel, falling back to MyRepublic, M1, Pacific
  Internet).
- **Busy-line guard** – before a scheduled test it reads the router's WAN traffic
  over UPnP. If more than `busy_threshold_mbps` is flowing (gaming, streaming,
  downloads) it waits `busy_retry_minutes` and tries again, and skips that hour
  only if the line stays busy. Manual tests always run. You can also pause
  scheduled tests from the dashboard.
- **Power cuts** – time when the add-on itself wasn't running (Pi off) is shown
  as *Not monitored*, never counted as uptime or downtime.

Open it from the **Net Monitor** entry in the Home Assistant sidebar.

## Home Assistant entities

The add-on publishes (and refreshes on every change):

| Entity | Meaning |
|---|---|
| `binary_sensor.net_monitor_internet` | `on` = international internet reachable |
| `sensor.net_monitor_download` | last download, Mbit/s |
| `sensor.net_monitor_upload` | last upload, Mbit/s |
| `sensor.net_monitor_ping` | last speedtest ping, ms |

## Options

| Option | Default | |
|---|---|---|
| `speedtest_interval_minutes` | 60 | Aligned to local midnight, so 60 = on the hour |
| `server_ids` | Singapore servers | Ookla server IDs, tried in order |
| `check_interval_seconds` | 30 | Connectivity check period |
| `check_targets` | Singapore + 1.1.1.1 | `host:port`; online if **any** answers |
| `busy_threshold_mbps` | 5 | `0` disables the busy-line guard |
| `busy_retry_minutes` | 10 | |
| `recovery_speedtest_min_outage_minutes` | 2 | Speedtest after outages at least this long |
| `notify_service` | empty | e.g. `notify.mobile_app_my_phone`; sent when the internet comes back |
| `notify_min_outage_minutes` | 1 | Don't notify for shorter blips |
| `retention_days` | 365 | |

Data use: one speedtest moves roughly 10–15 seconds' worth of your line speed in
each direction (about 100 MB per test at 40 Mbit/s, ~2.4 GB/day hourly). The
30-second connectivity check is a TCP handshake – a few hundred bytes.
