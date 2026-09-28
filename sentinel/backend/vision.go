package main

import "math"

// maskGrid marks the cells of a w×h grid that fall inside a camera's ignore zones.
func maskGrid(cam Camera, w, h int) []bool {
	mask := make([]bool, w*h)
	for _, r := range cam.MotionMasks {
		x0, y0 := int(r.X*float64(w)), int(r.Y*float64(h))
		x1, y1 := int(math.Ceil((r.X+r.W)*float64(w))), int(math.Ceil((r.Y+r.H)*float64(h)))
		for y := max(0, y0); y < min(h, y1); y++ {
			for x := max(0, x0); x < min(w, x1); x++ {
				mask[y*w+x] = true
			}
		}
	}
	for _, z := range cam.MotionZones {
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				if inPolygon(z.Points, (float64(x)+0.5)/float64(w), (float64(y)+0.5)/float64(h)) {
					mask[y*w+x] = true
				}
			}
		}
	}
	return mask
}

// components calls fn with the cells of every 8-connected group of `on` cells.
func components(on []bool, w, h int, fn func(cells []int)) {
	seen := make([]bool, len(on))
	var stack, cells []int
	for i := range on {
		if !on[i] || seen[i] {
			continue
		}
		seen[i] = true
		stack = append(stack[:0], i)
		cells = cells[:0]
		for len(stack) > 0 {
			c := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			cells = append(cells, c)
			cx, cy := c%w, c/w
			for dy := -1; dy <= 1; dy++ {
				for dx := -1; dx <= 1; dx++ {
					x, y := cx+dx, cy+dy
					if x < 0 || y < 0 || x >= w || y >= h {
						continue
					}
					if n := y*w + x; on[n] && !seen[n] {
						seen[n] = true
						stack = append(stack, n)
					}
				}
			}
		}
		fn(cells)
	}
}

// blob describes the biggest changed area between two greyscale frames.
type blob struct {
	size    int     // cells in the biggest connected area
	changed float64 // share of the watched frame that changed at all (lighting check)
	box     Rect    // normalised bounds of the biggest area
}

// biggestChange compares two w×h greyscale frames, ignoring masked cells.
func biggestChange(a, b []byte, mask []bool, w, h int) blob {
	on := make([]bool, len(a))
	total, watched := 0, 0
	for i := range a {
		if mask[i] {
			continue
		}
		watched++
		d := int(a[i]) - int(b[i])
		if d > 25 || d < -25 {
			on[i] = true
			total++
		}
	}
	var out blob
	if watched > 0 {
		out.changed = float64(total) / float64(watched)
	}
	components(on, w, h, func(cells []int) {
		if len(cells) <= out.size {
			return
		}
		x0, y0, x1, y1 := w, h, 0, 0
		for _, c := range cells {
			x, y := c%w, c/w
			x0, y0, x1, y1 = min(x0, x), min(y0, y), max(x1, x), max(y1, y)
		}
		out.size = len(cells)
		out.box = Rect{X: float64(x0) / float64(w), Y: float64(y0) / float64(h), W: float64(x1-x0+1) / float64(w), H: float64(y1-y0+1) / float64(h)}
	})
	return out
}
