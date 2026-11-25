package mobile

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func saveGeoScheduleFixture(t *testing.T, dir string, enabled bool, interval int, source string) {
	t.Helper()
	state := map[string]any{"settings": map[string]any{"geoAutoUpdate": enabled, "geoUpdateInterval": interval, "geoUrls": map[string]string{"geosite": source}}}
	data, _ := json.Marshal(state)
	if err := os.WriteFile(filepath.Join(dir, "state.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestScheduledGeoUpdatePersistsDueTimeAndSourceAcrossRestart(t *testing.T) {
	dir := t.TempDir()
	payload := onlineSiteFixture(t, "scheduled.example")
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); _, _ = w.Write(payload) }))
	defer server.Close()
	saveGeoScheduleFixture(t, dir, true, 2, server.URL)
	if _, err := runDueGeoUpdateAt(dir, 1000); err != nil {
		t.Fatal(err)
	}
	if _, err := runDueGeoUpdateAt(dir, 7_200_999); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatalf("not-yet-due schedule repeated network download: %d", calls.Load())
	}
	status, err := GeoUpdateSchedule(dir)
	if err != nil {
		t.Fatal(err)
	}
	var saved struct {
		LastSuccessAt int64 `json:"lastSuccessAt"`
		NextDueAt     int64 `json:"nextDueAt"`
	}
	if err := json.Unmarshal([]byte(status), &saved); err != nil {
		t.Fatal(err)
	}
	if saved.LastSuccessAt != 1000 || saved.NextDueAt != 7_201_000 {
		t.Fatalf("lost persisted completion: %s", status)
	}
	if _, err := runDueGeoUpdateAt(dir, 7_201_000); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 {
		t.Fatal("due update was skipped after reloading persisted schedule")
	}
	if source, ok := readGeoSource(dir, "geosite.dat"); !ok || source.URL != server.URL {
		t.Fatal("scheduled download omitted source metadata")
	}
	if actual, _ := os.ReadFile(filepath.Join(dir, "geosite.dat")); !bytes.Equal(actual, payload) {
		t.Fatal("scheduled update was not published")
	}
}

func TestDisabledGeoScheduleNeverDownloads(t *testing.T) {
	dir := t.TempDir()
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
	defer server.Close()
	saveGeoScheduleFixture(t, dir, false, 1, server.URL)
	if _, err := runDueGeoUpdateAt(dir, 1); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 0 {
		t.Fatal("disabled schedule made a network request")
	}
}

func TestMissingGeoSettingsAreDisabledAndMalformedSettingsFail(t *testing.T) {
	dir := t.TempDir()
	status, err := RunDueGeoUpdate(dir)
	if err != nil {
		t.Fatal(err)
	}
	var saved struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.Unmarshal([]byte(status), &saved); err != nil || saved.Enabled {
		t.Fatalf("first launch did not disable missing settings: %s %v", status, err)
	}
	if err := os.WriteFile(filepath.Join(dir, "state.json"), []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := GeoUpdateSchedule(dir); err == nil {
		t.Fatal("malformed settings silently enabled background work")
	}
}

func TestFailedGeoSchedulePreservesDataAndCanRetry(t *testing.T) {
	dir := t.TempDir()
	payload := onlineSiteFixture(t, "previous.example")
	var failed atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if failed.Load() {
			w.WriteHeader(503)
			return
		}
		_, _ = w.Write(payload)
	}))
	defer server.Close()
	saveGeoScheduleFixture(t, dir, true, 1, server.URL)
	if _, err := runDueGeoUpdateAt(dir, 1000); err != nil {
		t.Fatal(err)
	}
	failed.Store(true)
	if _, err := runDueGeoUpdateAt(dir, 3_601_000); err == nil {
		t.Fatal("failed update reported success")
	}
	status, err := GeoUpdateSchedule(dir)
	if err != nil {
		t.Fatal(err)
	}
	var saved struct {
		LastSuccessAt int64  `json:"lastSuccessAt"`
		Error         string `json:"error"`
	}
	_ = json.Unmarshal([]byte(status), &saved)
	if saved.LastSuccessAt != 1000 || saved.Error == "" {
		t.Fatalf("failed task advanced success or lost error: %s", status)
	}
	if actual, _ := os.ReadFile(filepath.Join(dir, "geosite.dat")); !bytes.Equal(actual, payload) {
		t.Fatal("failed update damaged prior data")
	}
	failed.Store(false)
	if _, err := runDueGeoUpdateAt(dir, 3_701_000); err != nil {
		t.Fatal(err)
	}
}

func TestDisablingGeoScheduleCancelsUnfinishedDownload(t *testing.T) {
	dir := t.TempDir()
	payload := onlineSiteFixture(t, "unchanged.example")
	if err := os.WriteFile(filepath.Join(dir, "geosite.dat"), payload, 0600); err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		close(started)
		<-r.Context().Done()
	}))
	defer server.Close()
	saveGeoScheduleFixture(t, dir, true, 1, server.URL)
	finished := make(chan error, 1)
	go func() { _, err := runDueGeoUpdateAt(dir, 1000); finished <- err }()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("update did not start")
	}
	saveGeoScheduleFixture(t, dir, false, 1, server.URL)
	CancelGeoUpdate(dir)
	select {
	case err := <-finished:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("disabled download was not cancelled")
	}
	if actual, _ := os.ReadFile(filepath.Join(dir, "geosite.dat")); !bytes.Equal(actual, payload) {
		t.Fatal("cancelled task published unfinished data")
	}
	status, err := GeoUpdateSchedule(dir)
	if err != nil {
		t.Fatal(err)
	}
	var saved struct {
		Enabled       bool  `json:"enabled"`
		LastSuccessAt int64 `json:"lastSuccessAt"`
	}
	_ = json.Unmarshal([]byte(status), &saved)
	if saved.Enabled || saved.LastSuccessAt != 0 {
		t.Fatalf("cancelled task reported successful update: %s", status)
	}
}
