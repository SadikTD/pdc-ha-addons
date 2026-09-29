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
  Each camera can keep the minutes that contain motion (plus 15 s around them)
  longer than its 24/7 footage, e.g. everything for 2 days and motion for 7.

## Pages

- **Live:** all cameras sized to fit the screen without scrolling (or 1–3 columns),
  from the low-bandwidth substreams shown in the camera's real shape, with only small
  labels over the picture and a glow on cameras that see motion. Cameras marked "Often
  switched off" show as switched off instead of as a problem, and never raise
  "not recording" alerts; they start recording by themselves when turned on. Every
  camera with a microphone has a speaker button: tap it to listen to that camera
  (any number at once). The sound stays on when you open the camera.
- **Camera:** full-quality live view with sound (one tap to mute or unmute, without
  reloading the video; recordings play with sound), and a scrubbing timeline: the
  playhead stays in the middle while you drag (or flick) the timeline, and the
  player shows preview frames of that moment as you go; let go to play from there.
  Click to jump, scroll or pinch to zoom (1 minute to 2 days). Motion events are
  bars above the track, missing footage is tinted red, and hovering shows a
  thumbnail. Playback up to 16×, previous/next motion, ±10 s, snapshots and
  fullscreen. Scroll on the video to zoom into the picture (up to 8×), drag to pan,
  double-click to zoom in or reset. Keys: space play/pause, ←/→ 10 s (Shift =
  1 min), [ / ] previous/next motion, + / − / 0 video zoom, I / O clip start/end,
  M sound, L live, F fullscreen, Backspace back.
- **Saving a clip:** press the scissors button, then drag the cyan handles on the
  timeline (or scrub and press I / O, or type exact times with ±1 s buttons),
  preview it, name it and save. Clips are cut from the recordings without
  re-encoding, so saving is fast and full quality.
- **Playback:** every camera playing the same moment side by side on one clock, to
  follow someone from camera to camera. The cameras are sized to fill the screen with
  the timeline always visible (the grid scrolls rather than shrinking videos too small).
  The timeline works like a camera's: drag to scrub with previews on every camera, let
  go to play. Previous/next motion on any camera, up to 8×, enlarge one camera (the
  others stay in a strip; the enlarged one zooms like a camera's player: scroll, drag,
  double-click, pinch, + / − / 0), listen to one camera.
- **Go to (G):** on a camera or in Playback, type a moment the way you'd say it
  ("yesterday 3:15 pm", "22:40", "mon 9am", "27 sep 2pm", "10 min ago") or pick a
  date and time.
- **Timeline:** every camera on one timeline with recording gaps and motion, people,
  cats and dogs as coloured markers (hover one to see who), which kinds to show, plus
  recorded percentage and people/animal counts per camera.
- **Events:** motion events by day with who was seen (Person, Cat, Dog, or plain
  Motion) and a picture framing them; filter by kind (with counts), camera, size and
  time range, or **search** in plain words: "person on the roof last night", "cats
  yesterday after 10pm", "dog ground floor this morning", "people 2 days ago between 1
  and 4am". The search shows how it understood the question. Hover a label and click ✕
  if it's wrong ("not a person"): the label goes and the camera learns that spot.
  Filters are part of the page address, and the list keeps loading as you scroll.
  Opening an event plays it on its camera with **‹ 12 / 340 ›** to step through the
  list (keys P / N) without going back; **Back** (or Backspace) returns to the list
  where you left it, with the last event watched highlighted. The same works from
  Summary highlights and Live's recent motion.
- **Summary:** one day at a glance: people, cats, dogs and motion per camera, when it
  was busiest (by hour), the clearest sightings, first and last person per camera, and
  whether every camera recorded the whole day. Pick any day.
- **Clips:** every saved clip with thumbnail, progress while saving, player,
  download, rename, pin and delete. Files are in `/media/sentinel/exports` (also
  in Home Assistant's Media panel). Unpinned clips are removed after the clip
  retention set in Settings (default 30 days).
- **System:** health, per-camera recorder stats (bitrate, restarts, last write),
  storage with a days-of-capacity forecast, clock status, and an activity log.
- **Settings:** add/edit/remove cameras (with a connection test), retention, audio,
  motion sensitivity and ignore zones, alerts and quiet windows, disk floor.
- **Ignore zones:** any number per camera, drawn as rectangles or any shape (click
  around a tree or road), movable and reshapable, with a live overlay showing where
  motion is being detected right now and which of it the zones ignore.

## People, cats and dogs

Every motion event is checked for people, cats and dogs. It never watches video: when
something moves, Sentinel looks at a few frames of the recording (in full quality), at
low priority, so recording and live view always come first.

A label needs two independent yeses: a fast model (YOLOX-s) must see it, and a bigger
one (YOLOX-m), looking again at a zoomed-in crop of that spot, must agree. On top of that:

- When the whole picture shows nobody, Sentinel looks again zoomed in on where it
  changed since just before the motion, which finds small, distant cats.
- Each camera learns spots where lookalikes fooled detection (laundry flapping on a
  line): a sighting there, or of something that was already there before the motion (a
  coat, someone sitting still), needs the bigger model to be clearly sure. Removing a
  wrong label teaches it at once.
- The fast model often takes a small cat for a person; the bigger model's closer look
  decides (calling something a person needs it to be clearly sure). Things cut off by
  the picture's edge need a surer answer too.
- **Animals that live here** (Settings): with only cats (or only dogs), every animal
  seen is called that; cameras looking down often make a cat look like a dog to the
  detector. With both, cat or dog is voted over several frames.
- Anything in a camera's ignore zones doesn't count.

Why an event did or didn't get a label: `GET /api/detection/explain/<camera>/<event id>`
checks it again step by step (nothing is saved). To check events again after changing
detection, `POST /api/detection/rescan?from=…&to=…` (add `only=seen` for just the events
where something was seen).

Events that just happened are checked within seconds; older ones (e.g. after an update)
are checked in the background, using at most a third of the time. The System page
shows how it's going. Cameras without motion detection aren't checked.

Night alerts use the same checks, so a cat never arrives as "Person".

## Night alerts on WhatsApp

Between the hours you choose (default 23:00–06:00), motion on the selected cameras
sends a WhatsApp picture of who moved, from the full-quality recording. Motion
shorter than the minimum length (insects, rain, IR flicker) is ignored, and each camera
waits the chosen gap before alerting again; motion during the gap isn't dropped, it's
sent as soon as the gap ends. While motion continues, a fresh picture can follow every
15 s to 2 min, and an hourly limit per camera stops rain or a swaying tree from
flooding the chat.

**Only people and animals** (on by default): Sentinel checks several frames across the
motion with a small object detector (YOLOX-tiny) for a person, cat or dog, and sends
the frame where they're seen best, always as the full picture, with the caption saying
who ("Person · Ground Floor", "2 people · …", "Cat · …"). If nothing is found
in the whole picture, it zooms into the area that moved and looks again, so a cat far
down a corridor is still caught. People and animals that were already there before the
motion (a sleeping cat) and those in ignore zones don't count. Motion with nobody in it
(a light change, the camera switching to night mode, a shadow) sends nothing; the
reason shows under Recent alerts. The detector only runs on the few frames an alert
looks at, never continuously, taking about 0.2 s per frame on a Raspberry Pi 5. If it
can't run, alerts fall back to plain motion (below) and a warning is logged.

With it off, any motion alerts: Sentinel sends the frame where something stands out
most from the empty scene just before. Optionally each alert is saved as a clip. There is no face
recognition.

Messages go through the **PDC WhatsApp Bridge** add-on (2.1.0 or newer). In Settings,
paste the bridge's `api_token`, then choose the chat: the bridge's recipient number or
any WhatsApp group the bridge's number is a member of. **Send a test picture** checks
the whole path. If WhatsApp is briefly offline (e.g. a router restart), alerts are
retried for 15 minutes.

**Cats and dogs** can go to a different chat than people (Settings → Night alerts →
"Cats and dogs go to"), so the main chat is only about people.

**Morning report:** each morning at the daily summary time, one picture of last night's
people (the clearest sightings during the night alert hours, framed, with camera and
time), or a "quiet night" card, with a one-line caption such as "Last night (11 PM –
6 AM): 2 people (Ground Floor 2:14 AM, 2nd Floor 2:16 AM) · 3 cats." It waits until
every event of the night has been checked. Preview it or send it now from Settings.

## Google Drive backup

Sentinel can upload motion events (10 s before to 10 s after, per camera or all
cameras), night alert clips and the clips you save, or any clip with its cloud button.
Motion is uploaded either only when a person, cat or dog was seen (the default: laundry,
light and leaves stay off Drive; it's uploaded once checked, usually within a minute)
or all of it. If detection isn't working, everything is uploaded rather than risk
missing someone.

Backups are kept by day and camera, named by time and who was seen:

```
Sentinel/2026-09-30/Drawing Room/21.14.03 · Person.mp4
Sentinel/2026-09-30/Roof/02.10.44 · Cat.mp4
Sentinel/2026-09-30/Ground Floor/03.02.15 · Night alert.mp4
```

(Backups from before this layout were moved to Drive's trash, which Google empties
after 30 days.) Set how much Drive space Sentinel may use: when it's full, the oldest
backups are deleted to make room (it also always leaves 1 GB free on the account, and
can delete backups older than a number of days). Setup, once:

1. In the Google Cloud Console create a project and enable the Google Drive API.
2. In Google Auth Platform, set an app name, choose External and **Publish app**
   (unpublished apps are disconnected after 7 days).
3. Create an OAuth client of type **TVs and Limited Input devices**.
4. Paste its client ID and secret in Sentinel's Settings, press Connect and enter the
   code Google shows you.

Sentinel uses the `drive.file` permission, so it can only see the files it uploads
(into a "Sentinel" folder). Uploads resume after network drops, and old backups can be
removed from Drive automatically.

## Sentinel app (Android)

The Sentinel app shows everything the Sentinel pages do, on your phone: live cameras,
recordings with the scrubbing timeline, events, clips and system health. It works
at home and from anywhere, with no port forwarding, VPN or other add-on:

- **At home** the app connects straight to Sentinel over Wi-Fi.
- **Away** it connects directly to Sentinel across the internet: both sides find each
  other through a tiny introducer (a Cloudflare Worker that only swaps addresses) and
  open a path through the routers (UDP hole punching). Video goes phone ↔ Sentinel and
  never passes through anyone else's server.
- Everything is **end-to-end encrypted** (QUIC with TLS 1.3). The app checks
  Sentinel's key against its **Sentinel ID**, so nobody can pretend to be your Sentinel.
- **Accounts:** under Settings → Sentinel app, add a user for each person (username and
  password). Viewers can be limited to some cameras; admins can also delete clips,
  restart cameras and see the system log. Each signed-in phone is listed and can be
  signed out on its own. Five wrong passwords lock the username for a growing time.
- **Events:** opening one plays it with **‹ 12 / 340 ›** at the top to step through the
  list; back returns to the list where you left it, with the event last watched marked.

Setup: install the app (APK from the GitHub releases), then log in. At home the app
finds Sentinel by itself; elsewhere, scan the QR code or type the Sentinel ID shown in
Settings. Sentinel uses UDP port 8555 on the Home Assistant host (it runs on the host
network, so no port mapping or Docker NAT sits in the way).

**Phone notifications** (optional): night alerts with the picture of who was seen,
cameras that stop or start recording, and any motion on the cameras each phone picks.
They use Google's free Firebase Cloud Messaging: create a Firebase project, download its
service account key (Project settings → Service accounts → Generate new private key) and
upload it under Settings → Sentinel app → Phone notifications. Sentinel registers the app
in the project itself. Messages only say what happened; the app fetches the picture from
Sentinel over its encrypted connection. Each phone chooses what it gets in the app
(App settings → Notifications). Night alerts follow the Night alerts settings (hours,
cameras, people/animals only) and work with or without WhatsApp.

## Home Assistant dashboard card

Sentinel installs a dashboard card at `/local/sentinel/sentinel-card.js`. Add it as a
dashboard resource (JavaScript module), then use:

```yaml
type: custom:sentinel-card
height: calc(100vh - var(--header-height))   # optional, default 75vh
```

It shows every camera live (sized to fit), recording status and the latest motion,
and opens cameras, playback and events inside the card. Cameras you add in Sentinel
appear automatically. It uses Home Assistant's own login (an ingress session), so no
port is exposed.

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
- `binary_sensor.roof_person`, `binary_sensor.roof_cat`, `binary_sensor.roof_dog`
  (on within a few seconds of someone being seen, off 30 s after the motion ends;
  cameras with motion detection only)
- `camera.roof_last_person_or_animal` (picture of the last one seen)

plus a "Sentinel NVR" device with `sensor.sentinel_nvr_storage_free`,
`sensor.sentinel_nvr_recordings_size`, `binary_sensor.sentinel_nvr_clock_problem` and
`binary_sensor.sentinel_nvr_person_any_camera` (and cat / dog).

Example: porch light on when a person is seen at night.

```yaml
automation:
  - alias: Person at night → porch light
    triggers:
      - trigger: state
        entity_id: binary_sensor.ground_floor_person
        to: "on"
    conditions:
      - condition: sun
        after: sunset
        before: sunrise
    actions:
      - action: light.turn_on
        target:
          entity_id: light.porch
```

If a camera stops recording for longer than the alert delay, Sentinel creates a
persistent notification and, if set, sends it to your notify service. It sends
another when recording resumes. Quiet windows (e.g. `03:55-04:20` for a nightly
router restart) suppress these alerts; recording is unaffected.

## Storage

Each camera keeps all footage (24/7) for a number of days, footage with motion
optionally longer, and footage in which a person was seen longer still (e.g. 2 days of
everything and 7 days of the moments with people). Events not checked yet count as
having a person until they are, so nothing important goes early.

Recordings: `/media/sentinel/recordings/<camera>/`, timeline previews (about 3%
of the recording size) in `/media/sentinel/previews/` (not included in Home
Assistant backups). Settings: `/addon_configs/<slug>/sentinel.json` (included).
