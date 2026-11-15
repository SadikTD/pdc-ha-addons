package main

import (
	"bytes"
	"image"
	"image/jpeg"
	"testing"
)

func TestMarkBoxes(t *testing.T) {
	g := image.NewGray(image.Rect(0, 0, 640, 360))
	for i := range g.Pix {
		g.Pix[i] = 128
	}
	var buf bytes.Buffer
	jpeg.Encode(&buf, g, nil)
	box := Rect{X: 0.5, Y: 0.5, W: 0.1, H: 0.2}
	out, err := jpeg.Decode(bytes.NewReader(markBoxes(buf.Bytes(), []Rect{box})))
	if err != nil {
		t.Fatal(err)
	}
	red := func(x, y int) bool {
		r, gg, b, _ := out.At(x, y).RGBA()
		return r>>8 > 200 && gg>>8 < 100 && b>>8 < 100
	}
	// left edge of the frame: 15% of the box width outside it, line 3 px wide
	if x := 308; !red(x, 216) { // int(310.4) - 3 .. +3
		t.Errorf("no red frame at x=%d: %v", x, out.At(x, 216))
	}
	if red(352, 216) { // inside the box: the cat stays visible
		t.Error("frame covers the box")
	}
	if !bytes.Equal(markBoxes([]byte("not a jpeg"), []Rect{box}), []byte("not a jpeg")) {
		t.Error("bad picture should come back unchanged")
	}
}
