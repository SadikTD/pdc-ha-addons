// Sentinel: a lightweight, reliability-first NVR add-on for Home Assistant.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

var version = "dev"

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	log.SetFlags(log.Ldate | log.Ltime)
	configDir := env("SENTINEL_CONFIG_DIR", "/config")
	media := env("SENTINEL_MEDIA", "/media/sentinel")
	www := env("SENTINEL_WWW", "/app/www")
	listen := env("SENTINEL_LISTEN", ":8099")
	logf("Sentinel %s starting (config %s, media %s)", version, configDir, media)

	for _, d := range []string{configDir, filepath.Join(media, "recordings"), filepath.Join(media, "events"), filepath.Join(media, "activity"), filepath.Join(media, "previews")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			logf("cannot create %s: %v", d, err)
		}
	}
	settings, err := loadSettings(filepath.Join(configDir, "sentinel.json"))
	if err != nil {
		log.Fatalf("settings: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	incidents := openIncidentLog(filepath.Join(media, "incidents.jsonl"))
	clock := newClock()
	store := newStore(filepath.Join(media, "recordings"), clock, incidents)
	store.Load()

	app := &App{
		ctx:       ctx,
		media:     media,
		settings:  settings,
		clock:     clock,
		store:     store,
		events:    newEventStore(filepath.Join(media, "events")),
		activity:  newActivityStore(filepath.Join(media, "activity")),
		previews:  newPreviewStore(filepath.Join(media, "previews")),
		incidents: incidents,
		detector:  newDetector(),
		go2rtc:    newGo2RTC(filepath.Join(os.TempDir(), "go2rtc.yaml"), incidents),
		mqtt:      newMQTT(),
		started:   time.Now(),
	}
	app.heartbeat.Store(time.Now().UnixMilli())
	app.secrets = loadSecrets(filepath.Join(configDir, "secrets.json"))
	app.drive = newDrive(app)
	app.clips = newClipStore(filepath.Join(media, "exports"), app)
	app.alerts = newAlerter(app, filepath.Join(media, "alerts.json"))
	app.objects = newObjectSensors()
	app.labeler = newLabeler(app)
	app.Init()
	go app.clips.Run(ctx)
	go app.labeler.Run(ctx)
	go app.drive.Run(ctx)
	go installCard(env("SENTINEL_HA_CONFIG", "/homeassistant"))
	go app.measureSizes()

	go clock.Run(ctx)
	go app.go2rtc.Run(ctx)
	s := settings.Get()
	if s.MQTTEnabled {
		go app.mqtt.Run(ctx)
	}
	app.Apply(s)
	incidents.Add("info", "", "Sentinel %s started with %d camera(s)", version, len(s.Cameras))
	go app.Background()

	app.push = newPush(app)
	app.remote = app.newRemote(configDir)
	routes := app.Routes(www)
	app.remote.Start(routes)
	srv := &http.Server{Addr: listen, Handler: panelOnly(routes), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("http: %v", err)
		}
	}()

	<-ctx.Done()
	logf("shutting down: closing recordings cleanly")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx)
	app.mu.Lock()
	for _, r := range app.recorders {
		r.Stop()
	}
	for _, m := range app.motion {
		m.Stop()
	}
	app.mu.Unlock()
	app.activity.Flush()
	app.previews.Close()
	logf("bye")
}
