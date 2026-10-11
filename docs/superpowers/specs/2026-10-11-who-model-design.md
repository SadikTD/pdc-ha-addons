# Sentinel "who" model — design

Date: 2026-10-11 · Status: draft for review

## Goal

Name people correctly on events and in night alerts, cheaply on the Pi.
**Priority: never put the wrong name on someone.** "Person" with no name is
acceptable; a wrong name is not (the user's main complaint today).

Success criteria (measured on held-out days the model never trained on):

- Wrong-name rate ≤ 1% of named sightings, day and night separately.
- Named rate higher than today's system at that same wrong-name rate.
- Strangers (Unknown persons, visitors) named as family ≤ 1%.
- On the Pi, the "who" step uses less CPU per sighting than today's
  YuNet + w600k_mbf + clothing path.

## What we know (2026-10-11, from /media/sentinel/faces)

- 14 days, ~9,950 face sightings. ~810 named by the user (8 regulars + ~25
  others), ~185 auto-named, ~8,940 unnamed. Night (IR): ~630, ~20 named.
- Faces are small (45–94 px), cameras are top-down, and at night the picture is
  grey IR. Often there is no usable face.
- Likely sources of wrong names today (to confirm in Phase 0):
  - clothing match (HSV histogram overlap 0.78, same day ±6 h)
  - auto-learning (`faceLearn` 0.55) feeds the system's own guesses back into
    the gallery, so one mistake attracts more
  - loose face thresholds (0.42, margin 0.07) for faces this small
- Night alerts are sent before face matching runs (`alerts.go fire()`), so they
  never carry names today.

## Approach

Train our own small **person re-identification** model on the PC (RTX 5070)
from home footage, using the cat-model recipe (D:\sentinel-train). It looks at
the whole person crop (head, hair, build and clothes) instead of only the face,
so it still works from above, from behind and in IR.

Clothes change every day, so body appearance identifies someone only **within
a day**. The decision rule follows from that:

1. **Anchor.** A sighting is anchored to a person when the user named it, or
   when the model is very sure (threshold set on held-out data for ≤1% wrong).
2. **Same-outfit memory.** Today's anchored sightings form a short-lived gallery
   (same day, ±12 h, day and IR kept apart). Other sightings are named only when
   they clearly match one person's same-outfit memory and nobody else's
   (margin).
3. **Cross-day gallery.** Only user-named sightings go in. Auto-named sightings
   never become long-term examples, so mistakes can't feed themselves.
4. **Event vote.** All of an event's sightings vote. If they disagree, nobody
   is named.
5. **Abstain.** Anything else stays unnamed: "Person".

## Components

### A. Phase 0: baseline and quick fix on the current system (Pi, small)

- `faces_eval` (throwaway Go test or `/api/faces/explain` loop): replay the
  user-named sightings leave-one-day-out and report wrong-name and named rates
  for face-only, clothing, and auto-learn. This is the baseline the new model
  has to beat.
- If clothing or auto-learn cause most of the wrong names, turn them off or
  tighten them right away. Cheap win while the model trains.

### B. Training data (PC, `D:\sentinel-train\who\`)

- `pull.py`: over SSH, copy people.json and seen/*.json (person, box, T, cam,
  event, by, night), and footage for people events still on the card (people
  footage is kept 7 days).
- `tracks.py`: per event, teacher person detector (D-FINE / Grounding DINO, as
  for the cats) plus IoU/appearance tracking. A track gets the user's name if
  one of its sightings is user-named. Tracks where boxes cross another person
  are cut at the crossing and never inherit across it.
- `review.py`: one contact sheet per person × day/night. The user rejects bad
  tracks (decisions.json, same flow as `decide.py`). **IR tracks are never
  auto-accepted.**
- Negatives: Unknown persons, visitors, "not this person" corrections.
- Split by day: the newest 2 days are held out for evaluation.

### C. Model (PC)

- Backbone: OSNet-x0.25 or MobileNetV3-small (ImageNet weights), input 256×128
  crop, 256-d embedding. Pick the smaller one unless it loses ≥2 points on the
  held-out test.
- Loss: ID classification + triplet. Batches mix day colour, grey copies, and
  real IR.
- `export.py` writes ONNX to `who.onnx` (~1–3 MB, expected ~15–30 ms per crop on
  the Pi with 1 thread).
- `eval.py` reports the success-criteria numbers above and picks thresholds.

### D. Pi runtime

- `detect.py`: new model kind `"who"` loads `/config/models/who.onnx`, same
  deploy path as `cat_<cam>.onnx`. Input: frame + person boxes. Output:
  embeddings.
- `faces.go` becomes "who": same files (people.json, seen/<day>.json, img/),
  same API and UI shapes, so the web UI and Android app keep working. A sighting
  stores the body embedding (and a 128 px body crop jpg for future retraining,
  since footage expires).
- Matching follows the decision rule above. Constants (anchor threshold, margin,
  outfit window) come from `eval.py`, not hand-tuned.
- People page: when an unknown sighting has no face, it shows the body crop
  instead. Naming and "not this person" work as today and take effect right
  away (gallery update, no retraining).
- **Replacement:** once the new model meets the success criteria on held-out
  data and in one live week, YuNet, w600k_mbf and the clothing histograms are
  removed from the image and the code. Exception: if keeping the face check
  measurably lowers wrong names in eval, the user decides whether to keep it.
- YOLOX person detection stays. It finds people, and the "who" model only runs
  on the boxes YOLOX gives it.

### E. Night alerts

- In `fire()`, after `shot()` finds the picture: run "who" on the person boxes
  in that frame and the 1–2 frames around it. Budget 3 s, then fall back.
- Caption label: the name(s) (`Dad`, `Dad, Mom`). Unsure or stranger:
  `Person` (exactly as today). Never "(not sure)".
- Same label for the app push and follow-up pictures.

### F. Retraining loop (manual, PC)

- Every few weeks, or after many corrections: `pull.py` → `tracks.py` →
  `review.py` → train → `eval.py`. Deploy only if the wrong-name rate does not
  get worse (copy `who.onnx`, restart the add-on).
- The model is never published (home footage).

## Error handling

- `who.onnx` missing or the detector is down: sightings stay unnamed, alerts say
  "Person", and an incident is logged. Recording and alerts are never blocked.
- Alert "who" step times out after 3 s: send "Person".

## Testing

- Phase 0 baseline numbers, then the same harness for the new model, on the
  same held-out days.
- Contact-sheet check of every auto-named sighting over one live week. The user
  spot-checks; wrong names are counted.
- Night-alert dry run: replay recent night events through `fire()` with no
  sending, and compare captions to ground truth.

## Out of scope

- Training on the Pi, cloud services, vehicles, publishing the model.

## Risks

- Night: few named IR examples. Expect a low named rate at night at first (it
  says "Person"); it grows with corrections and retrains.
- Similar-looking family members in similar clothes: the margin rule abstains
  instead of guessing.
- Footage for older named sightings has expired. Training data starts from the
  last 7 days plus body crops saved from now on.
