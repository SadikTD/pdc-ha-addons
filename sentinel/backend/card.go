package main

import (
	"bytes"
	_ "embed"
	"os"
	"path/filepath"
	"strings"
)

//go:embed card.js
var cardJS []byte

// installCard keeps /config/www/sentinel/sentinel-card.js (served by Home Assistant as
// /local/sentinel/sentinel-card.js) in step with this version of Sentinel.
func installCard(haConfig string) {
	slug := selfSlug()
	if slug == "" {
		return // not running under the Supervisor
	}
	if st, err := os.Stat(haConfig); err != nil || !st.IsDir() {
		return
	}
	data := bytes.ReplaceAll(cardJS, []byte("__SENTINEL_SLUG__"), []byte(slug))
	p := filepath.Join(haConfig, "www", "sentinel", "sentinel-card.js")
	if old, err := os.ReadFile(p); err == nil && bytes.Equal(old, data) {
		return
	}
	if err := writeFileAtomic(p, data, 0o644); err != nil {
		logf("dashboard card: %v", err)
		return
	}
	logf("dashboard card installed: /local/sentinel/sentinel-card.js (%s)", strings.TrimSpace(slug))
}
