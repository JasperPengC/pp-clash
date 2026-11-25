package mobile

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/metacubex/mihomo/component/geodata"
	"github.com/metacubex/mihomo/component/mmdb"
)

// Generated from scripts/resources.lock.json before compiling the core.
//
//go:embed geodata.zip
var bundledGeodata []byte

type geoEntry struct {
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

var geoNames = []string{"geoip.metadb", "geoip.dat", "geosite.dat", "ASN.mmdb"}
var verifiedGeoFiles = make(map[string]os.FileInfo)
var geodataNeedsReload bool

// Called under lifecycle before parsing any configuration, including imports.
// Valid user updates are retained; missing or damaged data is repaired offline.
func ensureGeodata(dir string) error {
	previous := make(map[string]os.FileInfo, len(geoNames))
	for _, name := range geoNames {
		path := geodataPath(dir, name)
		previous[path], _ = os.Lstat(path)
	}
	if err := installGeodata(dir, bundledGeodata, verifiedGeoFiles); err != nil {
		return err
	}
	for path, before := range previous {
		after, err := os.Lstat(path)
		if err == nil && (before == nil || !os.SameFile(before, after)) {
			geodataNeedsReload = true
		}
	}
	// Stop/Start keeps the Go process alive, so mihomo's cached matchers must be
	// reset before the next configuration parse. Active VPN rules keep their data.
	if geodataNeedsReload && tun == nil {
		geodata.ClearGeoSiteCache()
		geodata.ClearGeoIPCache()
		mmdb.ReloadIP()
		mmdb.ReloadASN()
		geodataNeedsReload = false
	}
	return nil
}

func installGeodata(dir string, bundle []byte, verified map[string]os.FileInfo) error {
	archive, err := zip.NewReader(bytes.NewReader(bundle), int64(len(bundle)))
	if err != nil {
		return err
	}
	if len(archive.File) != len(geoNames)+1 {
		return fmt.Errorf("invalid offline dataset count")
	}
	manifestFile, err := archive.Open("manifest.json")
	if err != nil {
		return err
	}
	var manifest map[string]geoEntry
	err = json.NewDecoder(io.LimitReader(manifestFile, 8192)).Decode(&manifest)
	_ = manifestFile.Close()
	if err != nil {
		return err
	}
	if len(manifest) != len(geoNames) {
		return fmt.Errorf("invalid offline dataset manifest")
	}
	for _, name := range geoNames {
		entry, ok := manifest[name]
		digest, err := hex.DecodeString(entry.SHA256)
		if !ok || err != nil || len(digest) != sha256.Size || entry.Size <= 0 || entry.Size > 64*1024*1024 {
			return fmt.Errorf("invalid offline dataset: %s", name)
		}
		path := geodataPath(dir, name)
		if validUserGeodata(dir, path, name) {
			continue
		}
		info, err := os.Lstat(path)
		if err == nil && info.Mode().IsRegular() && info.Size() == entry.Size {
			previous := verified[path]
			if previous != nil && os.SameFile(info, previous) && info.ModTime() == previous.ModTime() && info.Size() == previous.Size() {
				continue
			}
			if matchesGeodata(path, entry) {
				verified[path] = info
				continue
			}
		}
		if err := extractGeodata(archive, path, name, entry); err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		verified[path], err = os.Stat(path)
		if err != nil {
			return err
		}
	}
	return nil
}

func matchesGeodata(path string, entry geoEntry) bool {
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	hash := sha256.New()
	count, err := io.Copy(hash, io.LimitReader(file, entry.Size+1))
	return err == nil && count == entry.Size && hex.EncodeToString(hash.Sum(nil)) == entry.SHA256
}

// Match mihomo's legacy, case-insensitive dataset names when upgrading an install.
func geodataPath(dir, name string) string {
	entries, _ := os.ReadDir(dir)
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		alias := strings.ToLower(entry.Name())
		if strings.EqualFold(entry.Name(), name) || (name == "geoip.metadb" && (alias == "country.mmdb" || alias == "geoip.db")) {
			return filepath.Join(dir, entry.Name())
		}
	}
	return filepath.Join(dir, name)
}

func extractGeodata(archive *zip.Reader, path, name string, entry geoEntry) error {
	source, err := archive.Open(name)
	if err != nil {
		return err
	}
	defer source.Close()
	stage, err := os.CreateTemp(filepath.Dir(path), ".geodata-*")
	if err != nil {
		return err
	}
	defer os.Remove(stage.Name())
	defer stage.Close()
	hash := sha256.New()
	count, err := io.Copy(io.MultiWriter(stage, hash), io.LimitReader(source, entry.Size+1))
	if err != nil {
		return err
	}
	if count != entry.Size || hex.EncodeToString(hash.Sum(nil)) != entry.SHA256 {
		return fmt.Errorf("offline dataset checksum mismatch")
	}
	if err := stage.Sync(); err != nil {
		return err
	}
	if err := stage.Close(); err != nil {
		return err
	}
	return os.Rename(stage.Name(), path)
}
