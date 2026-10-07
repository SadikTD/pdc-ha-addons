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
	"sync"
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

	// Recordings and timeline previews go on their own disk when one is labelled for it.
	recDisk := newRecDisk(env("SENTINEL_REC_LABEL", "SENTINEL"), env("SENTINEL_REC_MOUNT", "/recdisk"))
	if recDisk.Mount() {
		logf("recordings disk %s mounted at %s", recDisk.Status()["device"], recDisk.Base())
	} else {
		// Never onto Home Assistant's SSD: nothing is recorded until the disk is back.
		recDisk.block()
		logf("no recordings disk (%s): NOT recording until it's plugged in", recDisk.Status()["error"])
	}
	recBase := recDisk.Base()

	for _, d := range []string{configDir, filepath.Join(recBase, "recordings"), filepath.Join(media, "events"), filepath.Join(media, "activity"), filepath.Join(recBase, "previews")} {
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
	store := newStore(filepath.Join(recBase, "recordings"), clock, incidents)
	store.Load(false)

	app := &App{
		ctx:       ctx,
		media:     media,
		recDisk:   recDisk,
		recBase:   recBase,
		settings:  settings,
		clock:     clock,
		store:     store,
		events:    newEventStore(filepath.Join(media, "events")),
		activity:  newActivityStore(filepath.Join(media, "activity")),
		previews:  newPreviewStore(filepath.Join(recBase, "previews")),
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
	app.catwatch = newCatWatcher(app, filepath.Join(media, "catwatch.json"))
	app.objects = newObjectSensors()
	app.labeler = newLabeler(app)
	app.faces = newFaces(app)
	app.mqtt.SetPeople(app.faces.People())
	app.faces.seedLastSeen()
	app.Init()
	diskAlert := func(msg string) {
		app.incidents.Add("error", "", "%s: recording is stopped until it's back", msg)
		notifyHA(settings.Get().NotifyService, "Sentinel: "+msg, "Cameras are NOT recording: the recordings card can't be found. Check the card and its reader (unplug and plug it back in). Recording starts again by itself when the card is back. This reminder repeats twice a day.", "recdisk", false)
	}
	if recDisk.Lost() {
		diskAlert("Recordings disk not found")
	} else {
		notifyHA("", "", "", "recdisk", true)
	}
	go recDisk.Watch(ctx.Done(), func(ok bool, msg string) {
		if !ok {
			diskAlert(msg)
			return
		}
		// Index what's on it (none of it was there while it was missing, e.g. at start).
		store.Load(true)
		store.loadIndexFile()
		app.incidents.Add("info", "", "%s", msg)
		notifyHA("", "", "", "recdisk", true)
	})
	app.disks = newDiskHealth(recDisk)
	go app.disks.Run(ctx, app.mqtt.SystemHealth)
	app.workload = newWorkload(app.disks)
	go app.workload.Run(ctx, app.mqtt.Workload)
	go app.clips.Run(ctx)
	go app.labeler.Run(ctx)
	go app.faces.Run(ctx)
	go app.presenceLoop(ctx)
	go app.drive.Run(ctx)
	go installCard(env("SENTINEL_HA_CONFIG", "/homeassistant"))
	go app.measureSizes()
	go store.WarmIndex(ctx)

	go clock.Run(ctx)
	go app.go2rtc.Run(ctx)
	s := settings.Get()
	app.mqtt.SetEnabled(ctx, s.MQTTEnabled)
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
	// All at once: each closes its own file, and a camera that hangs mustn't use up the
	// Supervisor's stop timeout for the others.
	var wg sync.WaitGroup
	app.mu.Lock()
	for _, r := range app.recorders {
		wg.Go(r.Stop)
	}
	for _, m := range app.motion {
		wg.Go(m.Stop)
	}
	app.mu.Unlock()
	wg.Wait()
	app.activity.Flush()
	app.events.Flush()
	store.SaveIndexFile()
	app.faces.flush()
	app.previews.Close()
	logf("bye")
}
