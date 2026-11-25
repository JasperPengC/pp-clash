package mobile

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/metacubex/mihomo/component/dialer"
)

var resourceMutation sync.Mutex

func canonicalGeoName(name string) (string, error) {
	for _, allowed := range geoNames {
		if strings.EqualFold(name, allowed) {
			return allowed, nil
		}
	}
	if strings.EqualFold(name, "country.mmdb") || strings.EqualFold(name, "geoip.db") {
		return "geoip.metadb", nil
	}
	return "", fmt.Errorf("不支持的 Geo 文件：%s", name)
}

func resourceDirectory(dir string) (string, error) {
	if !filepath.IsAbs(dir) || filepath.Clean(dir) == string(filepath.Separator) {
		return "", fmt.Errorf("资源目录无效")
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(dir)
}

type resourceFileInfo struct {
	Name      string `json:"name"`
	Size      int64  `json:"size"`
	Exists    bool   `json:"exists"`
	AliasOf   string `json:"aliasOf,omitempty"`
	SourceURL string `json:"sourceUrl,omitempty"`
}

// Country.mmdb and geoip.metadb are names of the same active mihomo database.
func ListResourceFiles(dir string) (string, error) {
	dir, err := resourceDirectory(dir)
	if err != nil {
		return "", err
	}
	lifecycle.Lock()
	defer lifecycle.Unlock()
	if err := ensureGeodata(dir); err != nil {
		return "", err
	}
	names := append(append([]string{}, geoNames...), "country.mmdb")
	files := make([]resourceFileInfo, 0, len(names))
	for _, name := range names {
		canonical, _ := canonicalGeoName(name)
		file := resourceFileInfo{Name: name}
		if name != canonical {
			file.AliasOf = canonical
		}
		info, err := os.Lstat(geodataPath(dir, canonical))
		if err == nil && info.Mode().IsRegular() {
			file.Size, file.Exists = info.Size(), true
		}
		if record, ok := readGeoSource(dir, canonical); ok {
			file.SourceURL = record.URL
		}
		files = append(files, file)
	}
	result, err := json.Marshal(files)
	return string(result), err
}

func geoDownloadURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Hostname() == "" || parsed.User != nil || len(raw) > 4096 {
		return nil, fmt.Errorf("Geo 下载地址必须是有效的 http(s) 链接")
	}
	return parsed, nil
}

// Download with a bounded stream and the same VPN socket protection as the core.
func DownloadGeoResource(dir, name, sourceURL, proxyURL, mirrorPrefix string) (int64, error) {
	return downloadGeoResource(context.Background(), dir, name, sourceURL, proxyURL, mirrorPrefix)
}

func downloadGeoResource(ctx context.Context, dir, name, sourceURL, proxyURL, mirrorPrefix string) (int64, error) {
	canonical, err := canonicalGeoName(name)
	if err != nil {
		return 0, err
	}
	if _, err := geoDownloadURL(sourceURL); err != nil {
		return 0, err
	}
	requestURL := sourceURL
	if mirrorPrefix = strings.TrimSpace(mirrorPrefix); mirrorPrefix != "" {
		if _, err := geoDownloadURL(mirrorPrefix); err != nil {
			return 0, fmt.Errorf("镜像地址无效：%w", err)
		}
		requestURL = strings.TrimRight(mirrorPrefix, "/") + "/" + sourceURL
	}
	parsed, err := geoDownloadURL(requestURL)
	if err != nil {
		return 0, err
	}
	dir, err = resourceDirectory(dir)
	if err != nil {
		return 0, err
	}
	if !resourceMutation.TryLock() {
		return 0, fmt.Errorf("资源正在更新，请稍后重试")
	}
	defer resourceMutation.Unlock()
	path := geodataPath(dir, canonical)
	if err := regularOrMissing(path); err != nil {
		return 0, err
	}
	if err := regularOrMissing(geoSourcePath(dir, canonical)); err != nil {
		return 0, err
	}
	transport := &http.Transport{
		DialContext:           (&net.Dialer{Timeout: 15 * time.Second, Control: dialer.DefaultSocketHook}).DialContext,
		TLSHandshakeTimeout:   15 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
		DisableCompression:    true,
	}
	defer transport.CloseIdleConnections()
	if proxyURL = strings.TrimSpace(proxyURL); proxyURL != "" {
		proxy, err := url.Parse(proxyURL)
		if err != nil || proxy.Hostname() == "" || (proxy.Scheme != "http" && proxy.Scheme != "https" && proxy.Scheme != "socks5" && proxy.Scheme != "socks5h") {
			return 0, fmt.Errorf("下载代理地址无效")
		}
		transport.Proxy = http.ProxyURL(proxy)
	}
	client := &http.Client{Transport: transport, Timeout: 180 * time.Second, CheckRedirect: func(request *http.Request, via []*http.Request) error {
		if len(via) >= 10 {
			return fmt.Errorf("下载重定向次数过多")
		}
		_, err := geoDownloadURL(request.URL.String())
		return err
	}}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return 0, err
	}
	request.Header.Set("User-Agent", "PPClash/geo")
	response, err := client.Do(request)
	if err != nil {
		return 0, fmt.Errorf("下载失败：%w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return 0, fmt.Errorf("下载失败：HTTP %d", response.StatusCode)
	}
	if response.ContentLength > maxGeoSize {
		return 0, fmt.Errorf("Geo 数据超过 64 MB")
	}
	stage, err := os.CreateTemp(dir, ".geodata-download-*")
	if err != nil {
		return 0, err
	}
	defer os.Remove(stage.Name())
	defer stage.Close()
	digest := sha256.New()
	size, err := io.Copy(io.MultiWriter(stage, digest), io.LimitReader(response.Body, maxGeoSize+1))
	if err != nil {
		return 0, fmt.Errorf("下载中断：%w", err)
	}
	if size <= 0 || size > maxGeoSize {
		return 0, fmt.Errorf("Geo 数据为空或超过 64 MB")
	}
	if err := stage.Sync(); err != nil {
		return 0, err
	}
	if err := stage.Close(); err != nil {
		return 0, err
	}
	if err := validateGeoFormat(stage.Name(), canonical); err != nil {
		return 0, err
	}
	record := geoSource{geoEntry: geoEntry{SHA256: hex.EncodeToString(digest.Sum(nil)), Size: size}, URL: sourceURL, UpdatedAt: time.Now().UTC().Format(time.RFC3339)}
	metadata, err := os.CreateTemp(dir, ".geodata-metadata-*")
	if err != nil {
		return 0, err
	}
	defer os.Remove(metadata.Name())
	defer metadata.Close()
	if err := json.NewEncoder(metadata).Encode(record); err != nil {
		return 0, err
	}
	if err := metadata.Sync(); err != nil {
		return 0, err
	}
	if err := metadata.Close(); err != nil {
		return 0, err
	}
	// Keep the network request outside the lifecycle lock; only publish validated files here.
	lifecycle.Lock()
	defer lifecycle.Unlock()
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	path = geodataPath(dir, canonical)
	if err := replaceGeoFiles([]geoReplacement{{path, stage.Name(), geoSourcePath(dir, canonical), metadata.Name()}}); err != nil {
		return 0, err
	}
	delete(verifiedGeoFiles, path)
	geodataNeedsReload = true
	return size, nil
}

type geoReplacement struct{ path, stage, metadataPath, metadataStage string }
type geoBackup struct{ path, backup string }

func regularOrMissing(path string) error {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("资源路径不是普通文件")
	}
	return nil
}

func backupGeoFile(path string) (geoBackup, error) {
	backup := geoBackup{path: path}
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return backup, nil
	}
	if err != nil {
		return backup, err
	}
	if !info.Mode().IsRegular() || info.Size() > maxGeoSize {
		return backup, fmt.Errorf("旧资源必须是 64 MB 以内的普通文件")
	}
	source, err := os.Open(path)
	if err != nil {
		return backup, err
	}
	defer source.Close()
	opened, err := source.Stat()
	if err != nil {
		return backup, err
	}
	if !os.SameFile(info, opened) {
		return backup, fmt.Errorf("备份时资源文件已变化")
	}
	stage, err := os.CreateTemp(filepath.Dir(path), ".geodata-backup-*")
	if err != nil {
		return backup, err
	}
	ready := false
	defer func() {
		_ = stage.Close()
		if !ready {
			_ = os.Remove(stage.Name())
		}
	}()
	// Android app-data policies prohibit hard links. Keep a synced, verified copy
	// before publishing either the replacement data or its source record.
	digest := sha256.New()
	size, err := io.Copy(io.MultiWriter(stage, digest), io.LimitReader(source, maxGeoSize+1))
	if err != nil {
		return backup, err
	}
	current, err := source.Stat()
	if err != nil {
		return backup, err
	}
	if size != info.Size() || size > maxGeoSize || current.Size() != info.Size() || !current.ModTime().Equal(info.ModTime()) {
		return backup, fmt.Errorf("备份时资源文件已变化")
	}
	if err := stage.Sync(); err != nil {
		return backup, err
	}
	if err := stage.Close(); err != nil {
		return backup, err
	}
	if !matchesGeodata(stage.Name(), geoEntry{Size: size, SHA256: hex.EncodeToString(digest.Sum(nil))}) {
		return backup, fmt.Errorf("旧资源备份校验失败")
	}
	backup.backup = stage.Name()
	ready = true
	return backup, nil
}

// Stage all data first and retain verified backups until both data and metadata commit.
func replaceGeoFiles(files []geoReplacement) error {
	return replaceGeoFilesWithRename(files, os.Rename)
}

func replaceGeoFilesWithRename(files []geoReplacement, rename func(string, string) error) (result error) {
	backups := make([]geoBackup, 0, len(files)*2)
	changed := false
	defer func() {
		retained := make(map[string]bool)
		if result != nil && changed {
			for i := len(backups) - 1; i >= 0; i-- {
				backup := backups[i]
				var err error
				if backup.backup == "" {
					err = os.Remove(backup.path)
					if os.IsNotExist(err) {
						err = nil
					}
				} else {
					err = rename(backup.backup, backup.path)
				}
				if err != nil {
					if backup.backup != "" {
						retained[backup.backup] = true
						result = fmt.Errorf("%w；恢复旧资源失败，备份保留于 %s：%v", result, backup.backup, err)
					} else {
						result = fmt.Errorf("%w；恢复旧资源失败：%v", result, err)
					}
				}
			}
		}
		for _, backup := range backups {
			if backup.backup != "" && !retained[backup.backup] {
				_ = os.Remove(backup.backup)
			}
		}
	}()
	for _, file := range files {
		for _, path := range []string{file.path, file.metadataPath} {
			backup, err := backupGeoFile(path)
			if err != nil {
				return err
			}
			backups = append(backups, backup)
		}
	}
	for _, file := range files {
		if err := rename(file.stage, file.path); err != nil {
			return err
		}
		changed = true
		if file.metadataStage != "" {
			if err := rename(file.metadataStage, file.metadataPath); err != nil {
				return err
			}
		} else if err := os.Remove(file.metadataPath); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

// Reinstall only geodata. Android's Go kernel is part of the signed application.
func ReinstallBundledResources(dir string) error {
	dir, err := resourceDirectory(dir)
	if err != nil {
		return err
	}
	if !resourceMutation.TryLock() {
		return fmt.Errorf("资源正在更新，请稍后重试")
	}
	defer resourceMutation.Unlock()
	staging, err := os.MkdirTemp(dir, ".geodata-reinstall-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(staging)
	if err := installGeodata(staging, bundledGeodata, make(map[string]os.FileInfo)); err != nil {
		return err
	}
	lifecycle.Lock()
	defer lifecycle.Unlock()
	files := make([]geoReplacement, 0, len(geoNames))
	for _, name := range geoNames {
		files = append(files, geoReplacement{geodataPath(dir, name), filepath.Join(staging, name), geoSourcePath(dir, name), ""})
	}
	if err := replaceGeoFiles(files); err != nil {
		return err
	}
	for _, file := range files {
		delete(verifiedGeoFiles, file.path)
	}
	geodataNeedsReload = true
	return nil
}
