package main

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"os"
	"slices"
	"sort"
	"strings"
	"time"

	"golang.org/x/image/draw"
	"golang.org/x/image/font"
	"golang.org/x/image/font/gofont/gobold"
	"golang.org/x/image/font/gofont/goregular"
	"golang.org/x/image/font/opentype"
	"golang.org/x/image/math/fixed"
)

// The WhatsApp morning report: one picture of last night's people (a collage of the
// clearest sightings, or a card saying it was quiet) with a one-line caption. It covers
// the night alerts' hours and goes to the night alerts' chat, at the daily summary time.

type nightReport struct {
	From, To time.Time
	People   []Event // events with a person, oldest first
	Cats     int
	Dogs     int
}

func (a *App) nightReport(now time.Time) nightReport {
	n := a.settings.Get().NightAlerts
	day := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.Local)
	from := day.Add(time.Duration(hhmm(n.From)) * time.Minute)
	to := day.Add(time.Duration(hhmm(n.To)) * time.Minute)
	if !from.Before(to) { // e.g. 23:00 - 06:00: starts yesterday
		from = from.AddDate(0, 0, -1)
	}
	if to.After(now) { // report sent before the window ends (odd settings): the last full night
		from, to = from.AddDate(0, 0, -1), to.AddDate(0, 0, -1)
	}
	r := nightReport{From: from, To: to}
	for _, e := range a.events.Filter(nil, from.UnixMilli(), to.UnixMilli(), 0, func(e *Event) bool { return len(e.Labels) > 0 && e.Start >= from.UnixMilli() }) {
		if e.Has("person") {
			r.People = append(r.People, e)
		}
		if e.Has("cat") {
			r.Cats++
		}
		if e.Has("dog") {
			r.Dogs++
		}
	}
	sort.Slice(r.People, func(i, j int) bool { return r.People[i].Start < r.People[j].Start })
	return r
}

func clock12(t time.Time) string { return t.In(time.Local).Format("3:04 PM") }

// hourShort: "11 PM", or "5:30 AM" when not on the hour.
func hourShort(t time.Time) string {
	if t.Minute() == 0 {
		return t.In(time.Local).Format("3 PM")
	}
	return clock12(t)
}

// caption: "🌅 Morning report · Wed 30 Sep
// Last night (11 PM – 6 AM): 2 people · Ground Floor 2:14 AM, 2nd Floor 2:16 AM · 3 cats"
func (r nightReport) caption(s Settings) string {
	var b strings.Builder
	fmt.Fprintf(&b, "🌅 *Morning report* · %s\n", r.To.Format("Mon 2 Jan"))
	span := hourShort(r.From) + " – " + hourShort(r.To)
	var parts []string
	if n := len(r.People); n > 0 {
		var seen []string
		for i, e := range r.People {
			if i == 6 {
				seen = append(seen, fmt.Sprintf("+%d more", n-6))
				break
			}
			seen = append(seen, fmt.Sprintf("%s %s", cameraName(s, e.Cam), clock12(time.UnixMilli(e.Start))))
		}
		parts = append(parts, fmt.Sprintf("%d %s (%s)", n, map[bool]string{true: "person", false: "people"}[n == 1], strings.Join(seen, ", ")))
	}
	if r.Cats > 0 {
		parts = append(parts, fmt.Sprintf("%d cat%s", r.Cats, map[bool]string{true: "", false: "s"}[r.Cats == 1]))
	}
	if r.Dogs > 0 {
		parts = append(parts, fmt.Sprintf("%d dog%s", r.Dogs, map[bool]string{true: "", false: "s"}[r.Dogs == 1]))
	}
	if len(parts) == 0 {
		fmt.Fprintf(&b, "Last night (%s): quiet, no people or animals seen.", span)
	} else {
		fmt.Fprintf(&b, "Last night (%s): %s.", span, strings.Join(parts, " · "))
	}
	return b.String()
}

// picture: up to 6 of the clearest people sightings (at most 2 per camera, not minutes
// apart), each with its camera and time; or a card when nobody was seen.
func (r nightReport) picture(a *App, s Settings) ([]byte, error) {
	var picks []Event
	cands := slices.Clone(r.People)
	sort.SliceStable(cands, func(i, j int) bool { return bestScore(cands[i]) > bestScore(cands[j]) })
	per := map[string]int{}
	for _, e := range cands {
		if len(picks) == 6 {
			break
		}
		if !e.Snap || per[e.Cam] >= 2 || slices.ContainsFunc(picks, func(p Event) bool { return p.Cam == e.Cam && abs64(p.Start-e.Start) < 5*60_000 }) {
			continue
		}
		per[e.Cam]++
		picks = append(picks, e)
	}
	sort.Slice(picks, func(i, j int) bool { return picks[i].Start < picks[j].Start })

	const tw, th = 640, 360
	faces := loadFaces()
	if len(picks) == 0 {
		img := image.NewRGBA(image.Rect(0, 0, 1280, 480))
		draw.Draw(img, img.Bounds(), &image.Uniform{color.RGBA{11, 15, 23, 255}}, image.Point{}, draw.Src)
		text(img, faces.big, 80, 200, "Quiet night", color.RGBA{226, 232, 240, 255})
		text(img, faces.small, 80, 270, "No people or animals seen, "+strings.ToLower(r.To.Format("Mon 2 Jan")), color.RGBA{148, 163, 184, 255})
		return encodeJPEG(img)
	}
	cols := 2
	if len(picks) == 1 {
		cols = 1
	}
	rows := (len(picks) + cols - 1) / cols
	img := image.NewRGBA(image.Rect(0, 0, cols*tw, rows*th))
	draw.Draw(img, img.Bounds(), &image.Uniform{color.RGBA{11, 15, 23, 255}}, image.Point{}, draw.Src)
	for i, e := range picks {
		x, y := (i%cols)*tw, (i/cols)*th
		cell := image.Rect(x, y, x+tw, y+th)
		if src, err := decodeJPEGFile(a.events.SnapPath(e.Cam, e.ID)); err == nil {
			draw.CatmullRom.Scale(img, cell, src, src.Bounds(), draw.Src, nil)
			// Frame whoever was seen.
			for _, o := range e.Objects {
				if o.T != e.Objects[0].T {
					continue
				}
				c := color.RGBA{219, 39, 119, 255}
				if o.Label != "person" {
					c = color.RGBA{101, 163, 13, 255}
				}
				box := image.Rect(x+int(o.Box.X*tw), y+int(o.Box.Y*th), x+int((o.Box.X+o.Box.W)*tw), y+int((o.Box.Y+o.Box.H)*th))
				rectOutline(img, box, 3, c)
			}
		}
		label := fmt.Sprintf("%s · %s", cameraName(s, e.Cam), clock12(time.UnixMilli(e.Start)))
		w := font.MeasureString(faces.small, label).Ceil()
		draw.Draw(img, image.Rect(x+10, y+10, x+30+w, y+52), &image.Uniform{color.RGBA{0, 0, 0, 170}}, image.Point{}, draw.Over)
		text(img, faces.small, x+20, y+40, label, color.White)
		if x > 0 {
			draw.Draw(img, image.Rect(x-2, y, x+2, y+th), &image.Uniform{color.RGBA{11, 15, 23, 255}}, image.Point{}, draw.Src)
		}
		if y > 0 {
			draw.Draw(img, image.Rect(x, y-2, x+tw, y+2), &image.Uniform{color.RGBA{11, 15, 23, 255}}, image.Point{}, draw.Src)
		}
	}
	return encodeJPEG(img)
}

func bestScore(e Event) float64 {
	if len(e.Objects) > 0 {
		return e.Objects[0].Score
	}
	return 0
}

type faceSet struct{ big, small font.Face }

func loadFaces() faceSet {
	mk := func(ttf []byte, size float64) font.Face {
		f, err := opentype.Parse(ttf)
		if err != nil {
			return nil
		}
		face, err := opentype.NewFace(f, &opentype.FaceOptions{Size: size, DPI: 72, Hinting: font.HintingFull})
		if err != nil {
			return nil
		}
		return face
	}
	return faceSet{big: mk(gobold.TTF, 64), small: mk(goregular.TTF, 26)}
}

func text(img *image.RGBA, face font.Face, x, y int, s string, c color.Color) {
	if face == nil {
		return
	}
	d := font.Drawer{Dst: img, Src: image.NewUniform(c), Face: face, Dot: fixed.P(x, y)}
	d.DrawString(s)
}

func rectOutline(img *image.RGBA, r image.Rectangle, w int, c color.Color) {
	u := &image.Uniform{c}
	draw.Draw(img, image.Rect(r.Min.X, r.Min.Y, r.Max.X, r.Min.Y+w), u, image.Point{}, draw.Src)
	draw.Draw(img, image.Rect(r.Min.X, r.Max.Y-w, r.Max.X, r.Max.Y), u, image.Point{}, draw.Src)
	draw.Draw(img, image.Rect(r.Min.X, r.Min.Y, r.Min.X+w, r.Max.Y), u, image.Point{}, draw.Src)
	draw.Draw(img, image.Rect(r.Max.X-w, r.Min.Y, r.Max.X, r.Max.Y), u, image.Point{}, draw.Src)
}

func decodeJPEGFile(p string) (image.Image, error) {
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return jpeg.Decode(f)
}

func encodeJPEG(img image.Image) ([]byte, error) {
	var buf bytes.Buffer
	err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 85})
	return buf.Bytes(), err
}

// morningReport sends the report to WhatsApp (called once a day at the summary time).
func (a *App) morningReport(now time.Time) error {
	s := a.settings.Get()
	if !s.WhatsApp.MorningReport || s.WhatsApp.To == "" {
		return nil
	}
	r := a.nightReport(now)
	img, err := r.picture(a, s)
	if err != nil {
		return err
	}
	key := "sentinel:report:" + r.To.Format("20060102")
	return a.alerts.wa.SendImage(s.WhatsApp.To, img, r.caption(s), key)
}
