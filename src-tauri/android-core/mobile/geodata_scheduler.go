package mobile

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const geoStatusFile = "geo-update-status.json"

type geoSettings struct {
	Enabled     bool              `json:"geoAutoUpdate"`
	Interval    int64             `json:"geoUpdateInterval"`
	URLs        map[string]string `json:"geoUrls"`
	GitHubProxy string            `json:"githubProxy"`
	MixedPort   int               `json:"mixedPort"`
}

type geoUpdateStatus struct {
	Enabled       bool   `json:"enabled"`
	IntervalHours int64  `json:"intervalHours"`
	LastSuccessAt int64  `json:"lastSuccessAt,omitempty"`
	LastAttemptAt int64  `json:"lastAttemptAt,omitempty"`
	NextDueAt     int64  `json:"nextDueAt,omitempty"`
	Error         string `json:"error,omitempty"`
}

var geoUpdateJobs = struct {
	sync.Mutex
	cancel map[string]context.CancelFunc
}{cancel: make(map[string]context.CancelFunc)}

func readGeoJSON(path string, output any) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() > 64*1024*1024 {
		return fmt.Errorf("Geo 设置或状态文件无效")
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	decoder := json.NewDecoder(io.LimitReader(file, 64*1024*1024+1))
	if err := decoder.Decode(output); err != nil {
		return fmt.Errorf("Geo 设置或状态无法解析：%w", err)
	}
	if decoder.Decode(new(any)) != io.EOF {
		return fmt.Errorf("Geo 设置或状态含有多余内容")
	}
	return nil
}

func loadGeoSchedule(dir string) (geoSettings, geoUpdateStatus, error) {
	var state struct {
		Settings geoSettings `json:"settings"`
	}
	var status geoUpdateStatus
	if err := readGeoJSON(filepath.Join(dir, "state.json"), &state); err != nil && !os.IsNotExist(err) {
		return state.Settings, status, err
	}
	settings := state.Settings
	if settings.Interval == 0 {
		settings.Interval = 24
	}
	if settings.Interval < 1 || settings.Interval > 720 {
		return settings, status, fmt.Errorf("Geo 自动更新间隔必须为 1 至 720 小时")
	}
	if err := readGeoJSON(filepath.Join(dir, geoStatusFile), &status); err != nil && !os.IsNotExist(err) {
		return settings, status, err
	}
	status.Enabled, status.IntervalHours = settings.Enabled, settings.Interval
	status.NextDueAt = 0
	if settings.Enabled && status.LastSuccessAt > 0 {
		status.NextDueAt = status.LastSuccessAt + settings.Interval*3_600_000
	}
	return settings, status, nil
}

// GeoUpdateSchedule reads persisted settings without starting a window or the VPN.
func GeoUpdateSchedule(dir string) (string, error) {
	dir, err := resourceDirectory(dir)
	if err != nil {
		return "", err
	}
	_, status, err := loadGeoSchedule(dir)
	if err != nil {
		return "", err
	}
	bytes, err := json.Marshal(status)
	return string(bytes), err
}

func saveGeoUpdateStatus(dir string, status geoUpdateStatus) error {
	path := filepath.Join(dir, geoStatusFile)
	if err := regularOrMissing(path); err != nil {
		return err
	}
	stage, err := os.CreateTemp(dir, ".geo-update-status-*")
	if err != nil {
		return err
	}
	defer os.Remove(stage.Name())
	defer stage.Close()
	if err := json.NewEncoder(stage).Encode(status); err != nil {
		return err
	}
	if err := stage.Sync(); err != nil {
		return err
	}
	if err := stage.Close(); err != nil {
		return err
	}
	return os.Rename(stage.Name(), path)
}

// CancelGeoUpdate cancels the current download before any unfinished transaction publishes.
func CancelGeoUpdate(dir string) {
	canonical, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return
	}
	geoUpdateJobs.Lock()
	defer geoUpdateJobs.Unlock()
	if cancel := geoUpdateJobs.cancel[canonical]; cancel != nil {
		cancel()
	}
}

// RunDueGeoUpdate is called by Android WorkManager; the success ledger survives process death.
func RunDueGeoUpdate(dir string) (string, error) {
	return runDueGeoUpdate(dir, func() int64 { return time.Now().UnixMilli() })
}

func runDueGeoUpdateAt(dir string, now int64) (string, error) {
	return runDueGeoUpdate(dir, func() int64 { return now })
}

func runDueGeoUpdate(dir string, clock func() int64) (string, error) {
	dir, err := resourceDirectory(dir)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	geoUpdateJobs.Lock()
	if geoUpdateJobs.cancel[dir] != nil {
		geoUpdateJobs.Unlock()
		return GeoUpdateSchedule(dir)
	}
	geoUpdateJobs.cancel[dir] = cancel
	geoUpdateJobs.Unlock()
	defer func() { geoUpdateJobs.Lock(); delete(geoUpdateJobs.cancel, dir); geoUpdateJobs.Unlock() }()
	settings, status, err := loadGeoSchedule(dir)
	if err != nil {
		return "", err
	}
	now := clock()
	if !settings.Enabled || status.NextDueAt > now {
		return GeoUpdateSchedule(dir)
	}
	status.LastAttemptAt = now
	status.Error = ""
	if err := saveGeoUpdateStatus(dir, status); err != nil {
		return "", err
	}
	var updateError error
	updated := 0
	// The country.mmdb UI alias shares MetaDB and must not overwrite it a second time.
	for _, source := range []struct{ name, key string }{{"geoip.dat", "geoip"}, {"geosite.dat", "geosite"}, {"geoip.metadb", "mmdb"}, {"ASN.mmdb", "asn"}} {
		current, _, err := loadGeoSchedule(dir)
		if err != nil {
			updateError = err
			break
		}
		if !current.Enabled || ctx.Err() != nil {
			return GeoUpdateSchedule(dir)
		}
		url := strings.TrimSpace(current.URLs[source.key])
		if url == "" {
			continue
		}
		proxy, mirror := "", strings.TrimSpace(current.GitHubProxy)
		if mirror == "auto" {
			mirror = ""
			lifecycle.Lock()
			connected := tun != nil && home == dir
			lifecycle.Unlock()
			if connected && current.MixedPort > 0 && current.MixedPort <= 65535 {
				proxy = fmt.Sprintf("http://127.0.0.1:%d", current.MixedPort)
			}
		}
		if _, err := downloadGeoResource(ctx, dir, source.name, url, proxy, mirror); err != nil {
			updateError = fmt.Errorf("自动更新 %s 失败：%w", source.name, err)
			break
		}
		updated++
	}
	if ctx.Err() != nil {
		return GeoUpdateSchedule(dir)
	}
	if updated == 0 && updateError == nil {
		updateError = fmt.Errorf("未配置可用的 Geo 在线源")
	}
	current, _, err := loadGeoSchedule(dir)
	if err != nil {
		return "", err
	}
	if !current.Enabled {
		return GeoUpdateSchedule(dir)
	}
	status.Enabled, status.IntervalHours = current.Enabled, current.Interval
	if updateError == nil {
		status.LastSuccessAt = clock()
		status.NextDueAt = status.LastSuccessAt + current.Interval*3_600_000
	} else {
		status.Error = updateError.Error()
	}
	if err := saveGeoUpdateStatus(dir, status); err != nil {
		return "", err
	}
	bytes, err := json.Marshal(status)
	if updateError != nil {
		return string(bytes), updateError
	}
	return string(bytes), err
}
