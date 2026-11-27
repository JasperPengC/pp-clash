package mobile

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/metacubex/mihomo/component/geodata"
	"github.com/metacubex/mihomo/component/geodata/router"
	"github.com/metacubex/mihomo/constant"
	"google.golang.org/protobuf/proto"
)

func onlineSiteFixture(t *testing.T, domain string) []byte {
	t.Helper()
	data, err := proto.Marshal(&router.GeoSiteList{Entry: []*router.GeoSite{{
		CountryCode: "CN", Domain: []*router.Domain{{Type: router.Domain_Domain, Value: domain}},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestGeodataRestartUsesUpdatedMatcher(t *testing.T) {
	if os.Getenv("PPCLASH_TEST_GEODATA_RELOAD") == "" {
		command := exec.Command(os.Args[0], "-test.run=^TestGeodataRestartUsesUpdatedMatcher$")
		command.Env = append(os.Environ(), "PPCLASH_TEST_GEODATA_RELOAD=1")
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("geodata restart kept old rules: %v\n%s", err, output)
		}
		return
	}
	dir := t.TempDir()
	var payload atomic.Value
	payload.Store(onlineSiteFixture(t, "old-rule.example"))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(payload.Load().([]byte)) }))
	defer server.Close()
	if _, err := DownloadGeoResource(dir, "geosite.dat", server.URL, "", ""); err != nil {
		t.Fatal(err)
	}
	constant.SetHomeDir(dir)
	geodata.SetLoader("standard")
	if err := ensureGeodata(dir); err != nil {
		t.Fatal(err)
	}
	// Config parsing initializes Mihomo's case-sensitive asset filename before loading rules.
	if err := geodata.InitGeoSite(); err != nil {
		t.Fatal(err)
	}
	oldMatcher, err := geodata.LoadGeoSiteMatcher("cn")
	if err != nil || !oldMatcher.ApplyDomain("old-rule.example") {
		t.Fatalf("initial rules failed: %v", err)
	}
	payload.Store(onlineSiteFixture(t, "new-rule.example"))
	if _, err := DownloadGeoResource(dir, "geosite.dat", server.URL, "", ""); err != nil {
		t.Fatal(err)
	}
	// ensureGeodata is called before parsing the next Start/Validate while the VPN is stopped.
	if err := ensureGeodata(dir); err != nil {
		t.Fatal(err)
	}
	newMatcher, err := geodata.LoadGeoSiteMatcher("cn")
	if err != nil {
		t.Fatal(err)
	}
	if !newMatcher.ApplyDomain("new-rule.example") || newMatcher.ApplyDomain("old-rule.example") {
		t.Fatal("VPN restart kept the previous GeoSite matcher")
	}
	if err := os.WriteFile(geodataPath(dir, "geosite.dat"), []byte("damaged after use"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := ensureGeodata(dir); err != nil {
		t.Fatal(err)
	}
	repairedMatcher, err := geodata.LoadGeoSiteMatcher("cn")
	if err != nil {
		t.Fatal(err)
	}
	if repairedMatcher.ApplyDomain("new-rule.example") {
		t.Fatal("offline repair left the damaged user database in the matcher cache")
	}
}

func TestDownloadGeodataPersistsSourceAndRestart(t *testing.T) {
	dir := t.TempDir()
	bundle, _ := fixtureGeodata(t, false)
	if err := installGeodata(dir, bundle, make(map[string]os.FileInfo)); err != nil {
		t.Fatal(err)
	}
	updated := onlineSiteFixture(t, "downloaded.example")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(updated) }))
	defer server.Close()
	size, err := DownloadGeoResource(dir, "geosite.dat", server.URL+"/data", "", "")
	if err != nil || size != int64(len(updated)) {
		t.Fatalf("download failed: size=%d error=%v", size, err)
	}
	if err := installGeodata(dir, bundle, make(map[string]os.FileInfo)); err != nil {
		t.Fatal(err)
	}
	actual, _ := os.ReadFile(geodataPath(dir, "geosite.dat"))
	if !bytes.Equal(actual, updated) {
		t.Fatal("successful downloaded update was discarded after restart")
	}
	record, ok := readGeoSource(dir, "geosite.dat")
	if !ok || record.URL != server.URL+"/data" || record.UpdatedAt == "" {
		t.Fatal("download source was not persisted")
	}
}

func TestDownloadGeodataRejectsInvalidResponsesAndPreservesSource(t *testing.T) {
	for _, kind := range []string{"html", "wrong-type", "http-error", "oversized", "oversized-stream", "truncated"} {
		t.Run(kind, func(t *testing.T) {
			dir := t.TempDir()
			previous := onlineSiteFixture(t, "previous.example")
			good := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(previous) }))
			defer good.Close()
			if _, err := DownloadGeoResource(dir, "geosite.dat", good.URL, "", ""); err != nil {
				t.Fatal(err)
			}
			metadataPath := geoSourcePath(dir, "geosite.dat")
			oldMetadata, _ := os.ReadFile(metadataPath)
			bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch kind {
				case "http-error":
					http.Error(w, "unavailable", 503)
				case "oversized":
					w.Header().Set("Content-Length", "67108865")
					w.WriteHeader(200)
				case "oversized-stream":
					w.(http.Flusher).Flush()
					chunk := bytes.Repeat([]byte("x"), 8192)
					for written := int64(0); written <= maxGeoSize; written += int64(len(chunk)) {
						if _, err := w.Write(chunk); err != nil {
							return
						}
					}
				case "truncated":
					w.Header().Set("Content-Length", "1000")
					_, _ = w.Write(previous)
				case "wrong-type":
					_, _ = w.Write([]byte{10, 4, 10, 2, 'C', 'N'})
				default:
					_, _ = w.Write([]byte("<html>error</html>"))
				}
			}))
			defer bad.Close()
			if _, err := DownloadGeoResource(dir, "geosite.dat", bad.URL, "", ""); err == nil {
				t.Fatal("invalid download was accepted")
			}
			actual, _ := os.ReadFile(geodataPath(dir, "geosite.dat"))
			if !bytes.Equal(actual, previous) {
				t.Fatal("failed download replaced previous database")
			}
			newMetadata, _ := os.ReadFile(metadataPath)
			if !bytes.Equal(oldMetadata, newMetadata) {
				t.Fatal("failed download changed previous source record")
			}
			stages, _ := filepath.Glob(filepath.Join(dir, ".geodata-*"))
			for _, stage := range stages {
				if !strings.Contains(stage, ".geodata-source-") {
					t.Fatalf("leaked temporary file: %s", stage)
				}
			}
		})
	}
}

func TestDownloadGeodataSerializesMutations(t *testing.T) {
	dir := t.TempDir()
	started, release, completed := make(chan struct{}), make(chan struct{}), make(chan error, 1)
	data := onlineSiteFixture(t, "concurrent.example")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-release
		_, _ = w.Write(data)
	}))
	defer server.Close()
	go func() { _, err := DownloadGeoResource(dir, "geosite.dat", server.URL, "", ""); completed <- err }()
	<-started
	_, err := DownloadGeoResource(dir, "geosite.dat", server.URL, "", "")
	if err == nil || !strings.Contains(err.Error(), "正在更新") {
		t.Errorf("overlapping update was not rejected: %v", err)
	}
	if err := ReinstallBundledResources(dir); err == nil {
		t.Error("reinstall raced a running update")
	}
	close(release)
	if err := <-completed; err != nil {
		t.Fatal(err)
	}
	actual, _ := os.ReadFile(geodataPath(dir, "geosite.dat"))
	if !bytes.Equal(actual, data) {
		t.Fatal("concurrent request corrupted the committed update")
	}
}

func TestResourceCommitRollsBackAllFilesOnFailure(t *testing.T) {
	dir := t.TempDir()
	files := make([]geoReplacement, 0, 2)
	for _, name := range []string{"geoip.dat", "geosite.dat"} {
		path, metadata := filepath.Join(dir, name), geoSourcePath(dir, name)
		if err := os.WriteFile(path, []byte("previous "+name), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(metadata, []byte("previous source "+name), 0600); err != nil {
			t.Fatal(err)
		}
		stage, metaStage := path+".stage", metadata+".stage"
		if err := os.WriteFile(metaStage, []byte("new source"), 0600); err != nil {
			t.Fatal(err)
		}
		if name == "geoip.dat" {
			if err := os.WriteFile(stage, []byte("new database"), 0600); err != nil {
				t.Fatal(err)
			}
		}
		files = append(files, geoReplacement{path, stage, metadata, metaStage})
	}
	// The second staged file vanishes before commit; the first replacement must roll back too.
	if err := replaceGeoFiles(files); err == nil {
		t.Fatal("accepted missing staged database")
	}
	for _, file := range files {
		name := filepath.Base(file.path)
		data, _ := os.ReadFile(file.path)
		metadata, _ := os.ReadFile(file.metadataPath)
		if string(data) != "previous "+name || string(metadata) != "previous source "+name {
			t.Fatalf("rollback lost old data or source for %s", name)
		}
	}
}

func TestGeoBackupKeepsIndependentPreviousBytes(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "geosite.dat")
	previous := []byte("previous database bytes")
	if err := os.WriteFile(path, previous, 0600); err != nil {
		t.Fatal(err)
	}
	backup, err := backupGeoFile(path)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(backup.backup)
	if err := os.WriteFile(path, []byte("later bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	actual, err := os.ReadFile(backup.backup)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(actual, previous) {
		t.Fatal("backup must preserve independent previous bytes without hard links")
	}
}

func TestGeoRollbackFailureRetainsPreviousBytesForRecovery(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "geosite.dat")
	stage := filepath.Join(dir, "new-geosite.dat")
	metadata := filepath.Join(dir, "source.json")
	for name, data := range map[string]string{path: "previous bytes", stage: "new bytes", metadata: "previous source"} {
		if err := os.WriteFile(name, []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	retained := ""
	err := replaceGeoFilesWithRename([]geoReplacement{{path, stage, metadata, filepath.Join(dir, "missing-source")}}, func(from, to string) error {
		if to == path && strings.HasPrefix(filepath.Base(from), ".geodata-backup-") {
			retained = from
			return os.ErrPermission
		}
		return os.Rename(from, to)
	})
	if err == nil || retained == "" || !strings.Contains(err.Error(), retained) {
		t.Fatalf("missing retained backup recovery error: %v", err)
	}
	previous, readErr := os.ReadFile(retained)
	if readErr != nil || string(previous) != "previous bytes" {
		t.Fatalf("rollback failure discarded previous bytes: %v", readErr)
	}
	source, readErr := os.ReadFile(metadata)
	if readErr != nil || string(source) != "previous source" {
		t.Fatalf("unaffected metadata was lost: %v", readErr)
	}
}

func TestDownloadGeodataRejectsTraversalAndSymlink(t *testing.T) {
	dir := t.TempDir()
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		_, _ = w.Write(onlineSiteFixture(t, "safe.example"))
	}))
	defer server.Close()
	for _, name := range []string{"../geosite.dat", "/tmp/geosite.dat", "sub/geosite.dat", "mihomo", "geosite.dat/../geoip.dat"} {
		if _, err := DownloadGeoResource(dir, name, server.URL, "", ""); err == nil {
			t.Fatalf("accepted unsafe name %q", name)
		}
	}
	if requests.Load() != 0 {
		t.Fatal("unsafe names triggered network requests")
	}
	outside := filepath.Join(t.TempDir(), "outside.dat")
	if err := os.WriteFile(outside, []byte("outside database"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "geosite.dat")); err != nil {
		t.Fatal(err)
	}
	if _, err := DownloadGeoResource(dir, "geosite.dat", server.URL, "", ""); err == nil {
		t.Fatal("accepted symbolic link destination")
	}
	actual, _ := os.ReadFile(outside)
	if string(actual) != "outside database" {
		t.Fatal("download wrote outside resource directory")
	}
}

func TestDownloadGeodataMetadataFailurePreservesDatabase(t *testing.T) {
	dir := t.TempDir()
	path := geodataPath(dir, "geosite.dat")
	previous := onlineSiteFixture(t, "previous.example")
	if err := os.WriteFile(path, previous, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(geoSourcePath(dir, "geosite.dat"), 0700); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(onlineSiteFixture(t, "updated.example")) }))
	defer server.Close()
	if _, err := DownloadGeoResource(dir, "geosite.dat", server.URL, "", ""); err == nil {
		t.Fatal("accepted unwritable source record")
	}
	actual, _ := os.ReadFile(path)
	if !bytes.Equal(actual, previous) {
		t.Fatal("source persistence failure replaced old database")
	}
}

func TestBundledGeoFormatsAreValid(t *testing.T) {
	dir := t.TempDir()
	if err := installGeodata(dir, bundledGeodata, make(map[string]os.FileInfo)); err != nil {
		t.Fatal(err)
	}
	for _, name := range geoNames {
		if err := validateGeoFormat(geodataPath(dir, name), name); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestResourceListAliasesAndOfflineReinstall(t *testing.T) {
	dir := t.TempDir()
	if err := ReinstallBundledResources(dir); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(dir, "geoip.metadb"), filepath.Join(dir, "Country.mmdb")); err != nil {
		t.Fatal(err)
	}
	listing, err := ListResourceFiles(dir)
	if err != nil {
		t.Fatal(err)
	}
	var files []struct {
		Name   string `json:"name"`
		Exists bool   `json:"exists"`
		Size   int64  `json:"size"`
	}
	if err := json.Unmarshal([]byte(listing), &files); err != nil {
		t.Fatal(err)
	}
	if len(files) != 5 {
		t.Fatalf("resource page needs 5 logical rows, got %d", len(files))
	}
	for _, file := range files {
		if !file.Exists || file.Size == 0 {
			t.Fatalf("missing resource %s", file.Name)
		}
	}
	updated := onlineSiteFixture(t, "user.example")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(updated) }))
	defer server.Close()
	if _, err := DownloadGeoResource(dir, "geosite.dat", server.URL, "", ""); err != nil {
		t.Fatal(err)
	}
	if err := ReinstallBundledResources(dir); err != nil {
		t.Fatal(err)
	}
	if _, ok := readGeoSource(dir, "geosite.dat"); ok {
		t.Fatal("reinstall retained online source marker")
	}
	actual, _ := os.ReadFile(geodataPath(dir, "geosite.dat"))
	if bytes.Equal(actual, updated) {
		t.Fatal("reinstall did not restore offline data")
	}
}

func TestGeodataUserUpdateSurvivesProcessRestart(t *testing.T) {
	bundle, bundled := fixtureGeodata(t, false)
	dir := t.TempDir()
	if err := installGeodata(dir, bundle, make(map[string]os.FileInfo)); err != nil {
		t.Fatal(err)
	}
	updated := onlineSiteFixture(t, "updated.example")
	path := geodataPath(dir, "geosite.dat")
	if err := os.WriteFile(path, updated, 0600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(updated)
	record := map[string]any{"sha256": hex.EncodeToString(digest[:]), "size": len(updated), "url": "https://data.example/geosite.dat"}
	metadata, _ := json.Marshal(record)
	if err := os.WriteFile(filepath.Join(dir, ".geodata-source-geosite.dat.json"), metadata, 0600); err != nil {
		t.Fatal(err)
	}
	// A fresh cache models a new process, without relying on any global verification state.
	if err := installGeodata(dir, bundle, make(map[string]os.FileInfo)); err != nil {
		t.Fatal(err)
	}
	actual, _ := os.ReadFile(path)
	if !bytes.Equal(actual, updated) {
		t.Fatal("verified online database was overwritten by bundled data after restart")
	}
	// Damage an installed user update. The offline copy must repair it.
	if err := os.WriteFile(path, []byte("broken user database"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := installGeodata(dir, bundle, make(map[string]os.FileInfo)); err != nil {
		t.Fatal(err)
	}
	actual, _ = os.ReadFile(path)
	if !bytes.Equal(actual, bundled["geosite.dat"]) {
		t.Fatal("damaged online data was not repaired offline")
	}
}

func TestGeodataDoesNotTrustManifestForInvalidFormat(t *testing.T) {
	bundle, bundled := fixtureGeodata(t, false)
	dir := t.TempDir()
	invalid := []byte("<html>download server error</html>")
	digest := sha256.Sum256(invalid)
	metadata, _ := json.Marshal(map[string]any{"sha256": hex.EncodeToString(digest[:]), "size": len(invalid), "url": "https://data.example/geosite.dat"})
	path := geodataPath(dir, "geosite.dat")
	if err := os.WriteFile(path, invalid, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".geodata-source-geosite.dat.json"), metadata, 0600); err != nil {
		t.Fatal(err)
	}
	if err := installGeodata(dir, bundle, make(map[string]os.FileInfo)); err != nil {
		t.Fatal(err)
	}
	actual, _ := os.ReadFile(path)
	if !bytes.Equal(actual, bundled["geosite.dat"]) {
		t.Fatal("manifest allowed invalid format to replace the offline copy")
	}
}
