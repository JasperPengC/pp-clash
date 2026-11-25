package mobile

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	C "github.com/metacubex/mihomo/constant"
	"github.com/metacubex/mihomo/hub/route"
	"github.com/metacubex/mihomo/tunnel"
)

func TestStopRejectsDelayedControllerConfiguration(t *testing.T) {
	if serverLifecycleChild(t) {
		testDelayedControllerConfiguration(t, false)
	}
}

func TestNewControllerRejectsPreviousDelayedConfiguration(t *testing.T) {
	if serverLifecycleChild(t) {
		testDelayedControllerConfiguration(t, true)
	}
}

func testDelayedControllerConfiguration(t *testing.T, restart bool) {
	t.Helper()
	directory := t.TempDir()
	C.SetHomeDir(directory)
	fifo := filepath.Join(directory, "delayed-config.yaml")
	if err := syscall.Mkfifo(fifo, 0600); err != nil {
		t.Fatal(err)
	}
	controller := reserveStopTestAddress(t)
	oldProxy := reserveStopTestAddress(t)
	route.ReCreateServer(&route.Config{Addr: controller, Secret: "old"})
	t.Cleanup(Stop)
	client := controllerGenerationClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, "http://"+controller+"/configs?force=true",
		bytes.NewBufferString(fmt.Sprintf(`{"path":%q}`, fifo)))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer old")
	request.Header.Set("Content-Type", "application/json")
	requestDone := make(chan error, 1)
	go func() {
		response, err := client.Do(request)
		if response != nil {
			_ = response.Body.Close()
		}
		requestDone <- err
	}()
	type openedWriter struct {
		file *os.File
		err  error
	}
	opened := make(chan openedWriter, 1)
	go func() {
		file, err := os.OpenFile(fifo, os.O_WRONLY, 0600)
		opened <- openedWriter{file, err}
	}()
	var writer *os.File
	select {
	case result := <-opened:
		if result.err != nil {
			t.Fatal(result.err)
		}
		writer = result.file
	case <-ctx.Done():
		t.Fatal("old handler did not enter configuration FIFO read")
	}
	t.Cleanup(func() { _ = writer.Close() })
	// Reader/writer pairing proves that decoding has finished and the raw file
	// read is blocked. Stop must invalidate it without waiting for the FIFO.
	stopped := make(chan struct{})
	go func() { Stop(); close(stopped) }()
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("Stop waited for an old raw configuration file read")
	}
	select {
	case <-requestDone:
	case <-ctx.Done():
		t.Fatal("Stop did not close the old controller connection")
	}
	assertServerSocketBoundary(t, stopTestSocket{"old controller", "tcp4", controller}, false, "Stop")
	var currentProxy string
	if restart {
		route.ReCreateServer(&route.Config{Addr: controller, Secret: "current"})
		currentProxy = reserveStopTestAddress(t)
		controllerGenerationRequest(t, client, controller, "current", http.MethodPut,
			fmt.Sprintf(`{"payload":%q}`, fmt.Sprintf("port: %d\nmode: direct\nbind-address: 127.0.0.1\n", stopTestPort(t, currentProxy))))
		assertServerSocketBoundary(t, stopTestSocket{"current proxy", "tcp4", currentProxy}, true, "current PUT")
	}
	if _, err := fmt.Fprintf(writer, "port: %d\nmode: direct\nbind-address: 127.0.0.1\n", stopTestPort(t, oldProxy)); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	// The network connection was closed by Stop, so it cannot acknowledge the
	// handler's exit. Deterministic handler-completion tests also run against
	// the captured router in scripts/tests/android_controller_generation_test.go.
	deadline := time.After(time.Second)
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		assertServerSocketBoundary(t, stopTestSocket{"old proxy", "tcp4", oldProxy}, false, "delayed old PUT after Stop")
		if restart {
			assertServerSocketBoundary(t, stopTestSocket{"current proxy", "tcp4", currentProxy}, true, "delayed old PUT after new session")
		}
		select {
		case <-deadline:
			return
		case <-ticker.C:
		}
	}
}

func TestControllerConfigurationUpdatesRemainAvailable(t *testing.T) {
	if !serverLifecycleChild(t) {
		return
	}
	C.SetHomeDir(t.TempDir())
	route.SetEmbedMode(true)
	controller := reserveStopTestAddress(t)
	route.ReCreateServer(&route.Config{Addr: controller, Secret: "current"})
	t.Cleanup(Stop)
	client := controllerGenerationClient(t)
	putProxy := reserveStopTestAddress(t)
	controllerGenerationRequest(t, client, controller, "current", http.MethodPut,
		fmt.Sprintf(`{"payload":%q}`, fmt.Sprintf("port: %d\nmode: direct\nbind-address: 127.0.0.1\n", stopTestPort(t, putProxy))))
	assertServerSocketBoundary(t, stopTestSocket{"PUT proxy", "tcp4", putProxy}, true, "current PUT")
	patchProxy := reserveStopTestAddress(t)
	controllerGenerationRequest(t, client, controller, "current", http.MethodPatch,
		fmt.Sprintf(`{"port":%d}`, stopTestPort(t, patchProxy)))
	assertServerSocketBoundary(t, stopTestSocket{"PUT proxy", "tcp4", putProxy}, false, "current PATCH")
	assertServerSocketBoundary(t, stopTestSocket{"PATCH proxy", "tcp4", patchProxy}, true, "current PATCH")
	request, err := http.NewRequest(http.MethodPost, "http://"+controller+"/restart", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer current")
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("embedded controller exposed process restart: %d", response.StatusCode)
	}
	Stop()
	assertServerSocketBoundary(t, stopTestSocket{"PATCH proxy", "tcp4", patchProxy}, false, "Stop after PATCH")
}

func TestStopWaitsForEnteredControllerMutation(t *testing.T) {
	if !serverLifecycleChild(t) {
		return
	}
	C.SetHomeDir(t.TempDir())
	entered, release := make(chan struct{}), make(chan struct{})
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-release
		_, _ = io.WriteString(w, "proxies:\n  - name: direct\n    type: direct\n")
	}))
	defer provider.Close()
	controller := reserveStopTestAddress(t)
	proxy := reserveStopTestAddress(t)
	route.ReCreateServer(&route.Config{Addr: controller})
	t.Cleanup(Stop)
	yaml := fmt.Sprintf("port: %d\nmode: direct\nbind-address: 127.0.0.1\nproxy-providers:\n  blocked:\n    type: http\n    url: %s\n    path: blocked.yaml\n    interval: 0\n    health-check:\n      enable: false\n", stopTestPort(t, proxy), provider.URL)
	request, err := http.NewRequest(http.MethodPut, "http://"+controller+"/configs?force=true",
		bytes.NewBufferString(fmt.Sprintf(`{"payload":%q}`, yaml)))
	if err != nil {
		t.Fatal(err)
	}
	client := controllerGenerationClient(t)
	requestDone := make(chan struct{})
	go func() {
		response, _ := client.Do(request)
		if response != nil {
			_ = response.Body.Close()
		}
		close(requestDone)
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		close(release)
		t.Fatal("PUT did not enter ApplyConfig provider initialization")
	}
	assertServerSocketBoundary(t, stopTestSocket{"entered mutation proxy", "tcp4", proxy}, true, "entered PUT")
	stopped := make(chan struct{})
	go func() { Stop(); close(stopped) }()
	select {
	case <-stopped:
		close(release)
		<-requestDone
		t.Fatal("Stop returned before entered controller mutation completed")
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("Stop did not finish after entered mutation exited")
	}
	assertServerSocketBoundary(t, stopTestSocket{"entered mutation proxy", "tcp4", proxy}, false, "Stop after entered PUT")
	assertServerSocketBoundary(t, stopTestSocket{"controller", "tcp4", controller}, false, "Stop after entered PUT")
	select {
	case <-requestDone:
	case <-time.After(time.Second):
		t.Fatal("old request was not closed after Stop")
	}
}

func TestStopWaitsForControllerParserRollback(t *testing.T) {
	if !serverLifecycleChild(t) {
		return
	}
	C.SetHomeDir(t.TempDir())
	tunnel.SetMode(tunnel.Rule)
	fifo := filepath.Join(C.Path.HomeDir(), "delayed-client-cert.pem")
	if err := syscall.Mkfifo(fifo, 0600); err != nil {
		t.Fatal(err)
	}
	controller := reserveStopTestAddress(t)
	route.ReCreateServer(&route.Config{Addr: controller})
	t.Cleanup(Stop)
	yaml := fmt.Sprintf("mode: direct\nproxies:\n  - name: blocked\n    type: http\n    server: 127.0.0.1\n    port: 443\n    tls: true\n    certificate: %s\n    private-key: absent-key.pem\n", fifo)
	request, err := http.NewRequest(http.MethodPut, "http://"+controller+"/configs?force=true",
		bytes.NewBufferString(fmt.Sprintf(`{"payload":%q}`, yaml)))
	if err != nil {
		t.Fatal(err)
	}
	client := controllerGenerationClient(t)
	requestDone := make(chan struct{})
	go func() {
		response, _ := client.Do(request)
		if response != nil {
			_ = response.Body.Close()
		}
		close(requestDone)
	}()
	type openedWriter struct {
		file *os.File
		err  error
	}
	opened := make(chan openedWriter, 1)
	go func() { file, err := os.OpenFile(fifo, os.O_WRONLY, 0600); opened <- openedWriter{file, err} }()
	var writer *os.File
	select {
	case result := <-opened:
		if result.err != nil {
			t.Fatal(result.err)
		}
		writer = result.file
	case <-time.After(5 * time.Second):
		t.Fatal("PUT did not enter TLS certificate parsing")
	}
	defer writer.Close()
	// TLS loading follows temporaryUpdateGeneral. Read Mode only after Stop's
	// completion channel establishes ordering with the parser's rollback.
	stopped := make(chan struct{})
	go func() { Stop(); close(stopped) }()
	prematureStop := false
	select {
	case <-stopped:
		prematureStop = true
	case <-time.After(100 * time.Millisecond):
	}
	if _, err := writer.WriteString("invalid certificate\n"); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if prematureStop {
		t.Fatal("Stop returned before controller TLS parser rollback completed")
	}
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("Stop did not finish after parser rollback")
	}
	if tunnel.Mode() != tunnel.Rule {
		t.Fatalf("parser rollback was incomplete when Stop returned: %s", tunnel.Mode())
	}
	assertServerSocketBoundary(t, stopTestSocket{"controller", "tcp4", controller}, false, "Stop after parser rollback")
	select {
	case <-requestDone:
	case <-time.After(time.Second):
		t.Fatal("old PUT was not closed after Stop")
	}
	route.ReCreateServer(&route.Config{Addr: controller})
	controllerGenerationRequest(t, client, controller, "", http.MethodPatch, `{"mode":"global"}`)
	if tunnel.Mode() != tunnel.Global {
		t.Fatalf("new controller did not retain Global mode: %s", tunnel.Mode())
	}
}

func controllerGenerationClient(t *testing.T) *http.Client {
	t.Helper()
	client := &http.Client{Timeout: 5 * time.Second,
		Transport: &http.Transport{Proxy: nil, DisableKeepAlives: true}}
	t.Cleanup(client.CloseIdleConnections)
	return client
}

func controllerGenerationRequest(t *testing.T, client *http.Client, controller, secret, method, body string) {
	t.Helper()
	request, err := http.NewRequest(method, "http://"+controller+"/configs?force=true", bytes.NewBufferString(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+secret)
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	contents, readErr := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if response.StatusCode != http.StatusNoContent || readErr != nil {
		t.Fatalf("current %s failed: status=%d body=%q error=%v", method, response.StatusCode, contents, readErr)
	}
}
