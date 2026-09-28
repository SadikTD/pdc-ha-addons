package main

import (
	"encoding/binary"
	"errors"
	"io"
	"os"
)

// Recordings are fragmented MP4 (ftyp, moov, then moof+mdat pairs), which stays playable
// up to the last complete fragment even if power is lost mid-write. This file maps a
// recording's fragments so they can be served as HLS byte ranges for smooth seeking.

type Fragment struct {
	Offset   int64   // byte offset of moof
	Length   int64   // moof + mdat
	Start    float64 // seconds from file start (decode time of the video track)
	Duration float64 // seconds
}

type MP4Index struct {
	InitLength int64 // ftyp + moov
	Fragments  []Fragment
	Duration   float64
}

type box struct {
	typ        string
	start, end int64 // absolute offsets; payload starts at start+hdr
	hdr        int64
}

func readBoxHeader(r io.ReaderAt, off, limit int64) (box, error) {
	var h [16]byte
	if off+8 > limit {
		return box{}, io.EOF
	}
	if _, err := r.ReadAt(h[:8], off); err != nil {
		return box{}, err
	}
	size := int64(binary.BigEndian.Uint32(h[0:4]))
	b := box{typ: string(h[4:8]), start: off, hdr: 8}
	switch size {
	case 1:
		if _, err := r.ReadAt(h[8:16], off+8); err != nil {
			return box{}, err
		}
		size = int64(binary.BigEndian.Uint64(h[8:16]))
		b.hdr = 16
	case 0:
		size = limit - off
	}
	if size < b.hdr {
		return box{}, errors.New("bad box size")
	}
	b.end = off + size
	return b, nil
}

func childBoxes(r io.ReaderAt, parent box) []box {
	var out []box
	for off := parent.start + parent.hdr; off < parent.end; {
		b, err := readBoxHeader(r, off, parent.end)
		if err != nil || b.end > parent.end {
			break
		}
		out = append(out, b)
		off = b.end
	}
	return out
}

func readPayload(r io.ReaderAt, b box, max int64) []byte {
	n := b.end - b.start - b.hdr
	if n > max {
		n = max
	}
	if n <= 0 {
		return nil
	}
	buf := make([]byte, n)
	if _, err := r.ReadAt(buf, b.start+b.hdr); err != nil && err != io.EOF {
		return nil
	}
	return buf
}

func find(r io.ReaderAt, parent box, typ string) (box, bool) {
	for _, c := range childBoxes(r, parent) {
		if c.typ == typ {
			return c, true
		}
	}
	return box{}, false
}

type trackInfo struct {
	timescale      uint32
	defaultSampDur uint32
}

func parseMP4(path string) (*MP4Index, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	size := st.Size()
	idx := &MP4Index{}
	tracks := map[uint32]*trackInfo{}
	var videoID uint32
	var firstStart float64 = -1

	for off := int64(0); off < size; {
		b, err := readBoxHeader(f, off, size)
		if err != nil {
			break
		}
		if b.end > size { // truncated (still being written, or power cut)
			break
		}
		switch b.typ {
		case "moov":
			idx.InitLength = b.end
			videoID = parseMoov(f, b, tracks)
		case "moof":
			// The matching mdat must follow and be complete.
			next, err := readBoxHeader(f, b.end, size)
			if err != nil || next.typ != "mdat" || next.end > size {
				off = size
				continue
			}
			start, dur, ok := parseMoof(f, b, videoID, tracks)
			if ok && dur > 0 {
				if firstStart < 0 {
					firstStart = start
				}
				idx.Fragments = append(idx.Fragments, Fragment{Offset: b.start, Length: next.end - b.start, Start: start - firstStart, Duration: dur})
			}
			off = next.end
			continue
		}
		off = b.end
	}
	if idx.InitLength == 0 {
		return nil, errors.New("no moov box")
	}
	if n := len(idx.Fragments); n > 0 {
		last := idx.Fragments[n-1]
		idx.Duration = last.Start + last.Duration
	}
	return idx, nil
}

func parseMoov(r io.ReaderAt, moov box, tracks map[uint32]*trackInfo) (videoID uint32) {
	for _, c := range childBoxes(r, moov) {
		switch c.typ {
		case "trak":
			var id uint32
			var ti trackInfo
			isVideo := false
			if tkhd, ok := find(r, c, "tkhd"); ok {
				p := readPayload(r, tkhd, 32)
				if len(p) >= 24 {
					if p[0] == 1 {
						id = binary.BigEndian.Uint32(p[20:24])
					} else {
						id = binary.BigEndian.Uint32(p[12:16])
					}
				}
			}
			if mdia, ok := find(r, c, "mdia"); ok {
				if mdhd, ok := find(r, mdia, "mdhd"); ok {
					p := readPayload(r, mdhd, 32)
					if len(p) >= 24 {
						if p[0] == 1 {
							ti.timescale = binary.BigEndian.Uint32(p[20:24])
						} else {
							ti.timescale = binary.BigEndian.Uint32(p[12:16])
						}
					}
				}
				if hdlr, ok := find(r, mdia, "hdlr"); ok {
					p := readPayload(r, hdlr, 12)
					isVideo = len(p) >= 12 && string(p[8:12]) == "vide"
				}
			}
			if id != 0 {
				t := ti
				if old, ok := tracks[id]; ok {
					t.defaultSampDur = old.defaultSampDur
				}
				tracks[id] = &t
				if isVideo && videoID == 0 {
					videoID = id
				}
			}
		case "mvex":
			for _, trex := range childBoxes(r, c) {
				if trex.typ != "trex" {
					continue
				}
				p := readPayload(r, trex, 24)
				if len(p) >= 16 {
					id := binary.BigEndian.Uint32(p[4:8])
					t := tracks[id]
					if t == nil {
						t = &trackInfo{}
						tracks[id] = t
					}
					t.defaultSampDur = binary.BigEndian.Uint32(p[12:16])
				}
			}
		}
	}
	return videoID
}

// parseMoof returns start and duration (seconds) of the video track in this fragment.
func parseMoof(r io.ReaderAt, moof box, videoID uint32, tracks map[uint32]*trackInfo) (float64, float64, bool) {
	for _, traf := range childBoxes(r, moof) {
		if traf.typ != "traf" {
			continue
		}
		var trackID, defDur uint32
		var baseTime uint64
		var total uint64
		haveTfhd := false
		for _, c := range childBoxes(r, traf) {
			switch c.typ {
			case "tfhd":
				p := readPayload(r, c, 40)
				if len(p) < 8 {
					continue
				}
				flags := uint32(p[1])<<16 | uint32(p[2])<<8 | uint32(p[3])
				trackID = binary.BigEndian.Uint32(p[4:8])
				pos := 8
				if flags&0x01 != 0 {
					pos += 8
				}
				if flags&0x02 != 0 {
					pos += 4
				}
				if flags&0x08 != 0 && len(p) >= pos+4 {
					defDur = binary.BigEndian.Uint32(p[pos : pos+4])
				}
				haveTfhd = true
			case "tfdt":
				p := readPayload(r, c, 12)
				if len(p) >= 8 {
					if p[0] == 1 && len(p) >= 12 {
						baseTime = binary.BigEndian.Uint64(p[4:12])
					} else {
						baseTime = uint64(binary.BigEndian.Uint32(p[4:8]))
					}
				}
			}
		}
		if !haveTfhd || (videoID != 0 && trackID != videoID) {
			continue
		}
		t := tracks[trackID]
		if t == nil || t.timescale == 0 {
			return 0, 0, false
		}
		if defDur == 0 {
			defDur = t.defaultSampDur
		}
		for _, c := range childBoxes(r, traf) {
			if c.typ != "trun" {
				continue
			}
			p := readPayload(r, c, 1<<20)
			if len(p) < 8 {
				continue
			}
			flags := uint32(p[1])<<16 | uint32(p[2])<<8 | uint32(p[3])
			count := binary.BigEndian.Uint32(p[4:8])
			pos := 8
			if flags&0x001 != 0 {
				pos += 4
			}
			if flags&0x004 != 0 {
				pos += 4
			}
			per := 0
			for _, bit := range []uint32{0x100, 0x200, 0x400, 0x800} {
				if flags&bit != 0 {
					per += 4
				}
			}
			for i := uint32(0); i < count; i++ {
				if flags&0x100 != 0 {
					if pos+4 > len(p) {
						break
					}
					total += uint64(binary.BigEndian.Uint32(p[pos : pos+4]))
				} else {
					total += uint64(defDur)
				}
				pos += per
			}
		}
		ts := float64(t.timescale)
		return float64(baseTime) / ts, float64(total) / ts, true
	}
	return 0, 0, false
}
