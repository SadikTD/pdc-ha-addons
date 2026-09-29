package main

import (
	"bytes"
	"image"
	"image/jpeg"
	"net/http"
	"os"
	"strings"

	"golang.org/x/image/draw"
)

// Event pictures are up to 1280 px wide (~85 KB), but lists and grids show them at a few
// hundred pixels. Over remote access a grid of full pictures is megabytes, and the video
// the user then opens waits behind it. So lists ask for ?small=1: a 480 px copy (a fifth
// of the bytes), made on first ask and kept next to the original.

const smallWidth = 480

var smallSem = make(chan struct{}, 2) // scaling is quick, but not a burst of 100 at once

func smallPath(p string) string { return strings.TrimSuffix(p, ".jpg") + ".s.jpg" }

// removePicture deletes an event picture and its small copy.
func removePicture(p string) {
	_ = os.Remove(p)
	_ = os.Remove(smallPath(p))
}

// smallPicture returns the path of the small copy of p, making it if needed (or when p
// was replaced since, e.g. a new snapshot after a rescan). ok=false: serve p itself.
func smallPicture(p string) (string, bool) {
	src, err := os.Stat(p)
	if err != nil {
		return "", false
	}
	sp := smallPath(p)
	if st, err := os.Stat(sp); err == nil && !st.ModTime().Before(src.ModTime()) {
		return sp, true
	}
	smallSem <- struct{}{}
	defer func() { <-smallSem }()
	// Another request may have made it while this one waited.
	if st, err := os.Stat(sp); err == nil && !st.ModTime().Before(src.ModTime()) {
		return sp, true
	}
	f, err := os.Open(p)
	if err != nil {
		return "", false
	}
	img, err := jpeg.Decode(f)
	f.Close()
	if err != nil {
		return "", false
	}
	b := img.Bounds()
	if b.Dx() <= smallWidth {
		return "", false
	}
	dst := image.NewRGBA(image.Rect(0, 0, smallWidth, b.Dy()*smallWidth/b.Dx()))
	draw.BiLinear.Scale(dst, dst.Bounds(), img, b, draw.Src, nil)
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, dst, &jpeg.Options{Quality: 76}); err != nil {
		return "", false
	}
	if writeFileAtomic(sp, buf.Bytes(), 0o644) != nil {
		return "", false
	}
	return sp, true
}

// servePicture serves an event picture, small when asked (?small=1).
func servePicture(w http.ResponseWriter, r *http.Request, p string) {
	if r.URL.Query().Get("small") == "1" {
		if sp, ok := smallPicture(p); ok {
			p = sp
		}
	}
	w.Header().Set("Cache-Control", "private, max-age=86400")
	http.ServeFile(w, r, p)
}
