# Sentinel

A lightweight 24/7 camera recorder (NVR) for Home Assistant, built to keep recording
through router restarts, power cuts and flaky cameras.

## How it keeps recording

- **Recording is isolated.** Each camera has its own ffmpeg process that copies the
  main stream straight to disk (no re-encoding, a few % CPU per camera). Live view,
  motion detection and the UI run separately, so a problem there can't stop recording.
- **Watchdog.** Every 2 s Sentinel checks that each camera's file is still growing.
  If a stream stalls for 20 s (a hung connection, the usual reason NVRs silently
  stop recording), that camera's recorder is killed and restarted. Dropped
  connections are retried forever: after 1 s, 2 s, 4 s … then every 10 s, so
  cameras are back within seconds of a router restart.
- **Power-cut safe files.** Recordings are 1-minute fragmented MP4 files that are
  flushed every few seconds. A power cut loses at most the last few seconds; the
  interrupted file is repaired and kept on the next start. There is no database to
  corrupt: the file names are the index.
- **Clock-proof.** A Pi without an RTC battery boots with a stale clock, and NTP
  can't fix it while the internet is down. Sentinel records anyway (file names are
  unique, so nothing is ever overwritten), measures the true time against NTP
  servers itself, and corrects the timestamps of affected recordings once it can.
- **Self-healing.** Worker loops are supervised; the Home Assistant Supervisor
  restarts the add-on if the main loop or a recorder loop gets stuck.
- **Never fills the disk.** Recordings older than each camera's retention are
  deleted, and the oldest are removed early if free space drops below the minimum.

## Pages

- **Live:** all cameras in a grid (substreams, low bandwidth), with a recording
  badge and a glow on cameras that see motion.
- **Camera:** full-quality live view with audio, and a scrubbing timeline: the
  playhead stays in the middle while you drag (or flick) the timeline, and the
  player shows preview frames of that moment as you go; let go to play from there.
  Click to jump, scroll or pinch to zoom (1 minute to 2 days). Motion events are
  bars above the track, missing footage is tinted red, and hovering shows a
  thumbnail. Playback up to 16×, previous/next motion, ±10 s, snapshots and
  fullscreen. Scroll on the video to zoom into the picture (up to 8×), drag to pan,
  double-click to zoom in or reset. Keys: space play/pause, ←/→ 10 s (Shift =
  1 min), [ / ] previous/next motion, + / − / 0 video zoom, I / O clip start/end,
  L live, F fullscreen.
- **Saving a clip:** press the scissors button, then drag the cyan handles on the
  timeline (or scrub and press I / O, or type exact times with ±1 s buttons),
  preview it, name it and save. Clips are cut from the recordings without
  re-encoding, so saving is fast and full quality.
- **Timeline:** every camera on one timeline with recording gaps and motion, plus
  recorded percentage per camera.
- **Events:** motion events with thumbnails, by day, filterable by camera and size.
- **Clips:** every saved clip with thumbnail, progress while saving, player,
  download, rename, pin and delete. Files are in `/media/sentinel/exports` (also
  in Home Assistant's Media panel). Unpinned clips are removed after the clip
  retention set in Settings (default 30 days).
- **System:** health, per-camera recorder stats (bitrate, restarts, last write),
  storage with a days-of-capacity forecast, clock status, and an activity log.
- **Settings:** add/edit/remove cameras (with a connection test), retention, audio,
  motion sensitivity and ignore zones, alerts and quiet windows, disk floor.

## Adding a camera

Use the RTSP URLs from your camera or NVR, for example Hikvision
`rtsp://user:pass@IP:554/Streaming/Channels/101` (main) and `…/102` (substream).
Press **Test** to check each one. The substream is optional but recommended: the
live grid and motion detection use it.

Some cameras and NVRs allow only one or two connections per stream. Sentinel uses
one connection for recording, one for the substream (shared by motion detection
and live view) and one more for full-quality live view while you watch it.

## Home Assistant

With the Mosquitto broker add-on installed, each camera becomes a device with
(entity IDs follow the camera name, e.g. "Roof"):

- `binary_sensor.roof_motion`
- `binary_sensor.roof_recording` (off = not recording)
- `camera.roof_last_motion` (snapshot of the last motion)

plus a "Sentinel NVR" device with `sensor.sentinel_nvr_storage_free`,
`sensor.sentinel_nvr_recordings_size` and `binary_sensor.sentinel_nvr_clock_problem`.

If a camera stops recording for longer than the alert delay, Sentinel creates a
persistent notification and, if set, sends it to your notify service. It sends
another when recording resumes. Quiet windows (e.g. `03:55-04:20` for a nightly
router restart) suppress these alerts; recording is unaffected.

## Storage

Recordings: `/media/sentinel/recordings/<camera>/`, timeline previews (about 3%
of the recording size) in `/media/sentinel/previews/` (not included in Home
Assistant backups). Settings: `/addon_configs/<slug>/sentinel.json` (included).
