package main

import (
	"compress/gzip"
	"io"
	"net/http"
	"strings"
	"sync"
)

// compress gzips text answers (the web app's code, JSON, playlists): the app bundle
// shrinks from 1.2 MB to about a third, and event lists to a tenth, which matters on
// Home Assistant's remote access and the phone's mobile data. Video, pictures and the
// live proxy pass through untouched.
func compress(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") || r.Header.Get("Upgrade") != "" ||
			r.Header.Get("Range") != "" || strings.HasPrefix(r.URL.Path, "/go2rtc/") {
			h.ServeHTTP(w, r)
			return
		}
		gw := &gzipWriter{ResponseWriter: w}
		defer gw.close()
		h.ServeHTTP(gw, r)
	})
}

var gzipPool = sync.Pool{New: func() any {
	z, _ := gzip.NewWriterLevel(io.Discard, 5)
	return z
}}

type gzipWriter struct {
	http.ResponseWriter
	z           *gzip.Writer
	wroteHeader bool
}

func compressible(ct string) bool {
	ct, _, _ = strings.Cut(ct, ";")
	switch strings.TrimSpace(ct) {
	case "application/json", "text/javascript", "application/javascript", "text/css", "text/html", "text/plain",
		"image/svg+xml", "application/vnd.apple.mpegurl", "application/x-mpegurl":
		return true
	}
	return false
}

func (g *gzipWriter) WriteHeader(code int) {
	if g.wroteHeader {
		return
	}
	g.wroteHeader = true
	hd := g.Header()
	hd.Add("Vary", "Accept-Encoding")
	if code == http.StatusOK && hd.Get("Content-Encoding") == "" && compressible(hd.Get("Content-Type")) {
		hd.Del("Content-Length")
		hd.Del("Accept-Ranges")
		hd.Set("Content-Encoding", "gzip")
		if etag := hd.Get("ETag"); etag != "" && !strings.HasPrefix(etag, "W/") {
			hd.Set("ETag", "W/"+etag)
		}
		g.z = gzipPool.Get().(*gzip.Writer)
		g.z.Reset(g.ResponseWriter)
	}
	g.ResponseWriter.WriteHeader(code)
}

func (g *gzipWriter) Write(b []byte) (int, error) {
	if !g.wroteHeader {
		if g.Header().Get("Content-Type") == "" {
			g.Header().Set("Content-Type", http.DetectContentType(b))
		}
		g.WriteHeader(http.StatusOK)
	}
	if g.z != nil {
		return g.z.Write(b)
	}
	return g.ResponseWriter.Write(b)
}

func (g *gzipWriter) Flush() {
	if g.z != nil {
		g.z.Flush()
	}
	if f, ok := g.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (g *gzipWriter) Unwrap() http.ResponseWriter { return g.ResponseWriter }

func (g *gzipWriter) close() {
	if g.z != nil {
		g.z.Close()
		gzipPool.Put(g.z)
		g.z = nil
	}
}
