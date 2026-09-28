package main

import (
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

type StreamInfo struct {
	VideoCodec string  `json:"video_codec"`
	Width      int     `json:"width"`
	Height     int     `json:"height"`
	FPS        float64 `json:"fps"`
	AudioCodec string  `json:"audio_codec"`
}

func inputArgs(url string) []string {
	if strings.HasPrefix(url, "rtsp") {
		// TCP survives packet loss far better than UDP; the socket timeout (µs) makes
		// ffmpeg exit instead of hanging forever when a camera or the network drops.
		return []string{"-rtsp_transport", "tcp", "-timeout", "10000000"}
	}
	return []string{"-rw_timeout", "10000000"}
}

func probeStream(ctx context.Context, url string) (StreamInfo, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	args := append([]string{"-v", "error"}, inputArgs(url)...)
	args = append(args, "-show_entries", "stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate", "-of", "json", url)
	out, err := exec.CommandContext(ctx, "ffprobe", args...).Output()
	var info StreamInfo
	if err != nil {
		msg := err.Error()
		var ee *exec.ExitError
		if errors.As(err, &ee) && len(ee.Stderr) > 0 {
			lines := strings.Split(strings.TrimSpace(string(ee.Stderr)), "\n")
			msg = lines[len(lines)-1]
		}
		if ctx.Err() != nil {
			msg = "timed out - camera unreachable?"
		}
		return info, errors.New(redact(msg))
	}
	var res struct {
		Streams []struct {
			CodecType string `json:"codec_type"`
			CodecName string `json:"codec_name"`
			Width     int    `json:"width"`
			Height    int    `json:"height"`
			Avg       string `json:"avg_frame_rate"`
			R         string `json:"r_frame_rate"`
		} `json:"streams"`
	}
	if err := json.Unmarshal(out, &res); err != nil {
		return info, err
	}
	for _, s := range res.Streams {
		switch s.CodecType {
		case "video":
			if info.VideoCodec == "" {
				info.VideoCodec, info.Width, info.Height = s.CodecName, s.Width, s.Height
				info.FPS = parseRate(s.R)
				if info.FPS == 0 || info.FPS > 120 {
					info.FPS = parseRate(s.Avg)
				}
			}
		case "audio":
			if info.AudioCodec == "" {
				info.AudioCodec = s.CodecName
			}
		}
	}
	if info.VideoCodec == "" {
		return info, errors.New("no video in stream")
	}
	return info, nil
}

func parseRate(r string) float64 {
	a, b, ok := strings.Cut(r, "/")
	if !ok {
		f, _ := strconv.ParseFloat(r, 64)
		return f
	}
	x, _ := strconv.ParseFloat(a, 64)
	y, _ := strconv.ParseFloat(b, 64)
	if y == 0 {
		return 0
	}
	return float64(int(x/y*10+0.5)) / 10
}
