// These tests are overlaid into the controlled Mihomo copy, never module cache.
package route

import (
	"bytes"
	"fmt"
	"io"
	"net"
	stdhttp "net/http"
	stdhttptest "net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/metacubex/http"
	"github.com/metacubex/http/httptest"
	C "github.com/metacubex/mihomo/constant"
	"github.com/metacubex/mihomo/listener"
	"github.com/metacubex/mihomo/tunnel"
)

type generationDelayedBody struct {
	entered chan struct{}
	release chan struct{}
	reader  *strings.Reader
	started bool
}

func (b *generationDelayedBody) Read(p []byte) (int, error) {
	if !b.started {
		b.started = true
		close(b.entered)
		<-b.release
	}
	return b.reader.Read(p)
}

func (b *generationDelayedBody) Close() error { return nil }

// Capturing the real router keeps the handler observable after Server.Close.
// The body barrier proves request decoding is outside the mutation gate.
func TestControllerGenerationRejectsDelayedMutations(t *testing.T) {
	C.SetHomeDir(t.TempDir())
	for _, method := range []string{http.MethodPut, http.MethodPatch} {
		for _, recreate := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/recreate=%t", method, recreate), func(t *testing.T) {
				address := generationAddress(t)
				ReCreateServer(&Config{Addr: address})
				oldRouter := httpServer.Handler
				t.Cleanup(func() {
					ReCreateServer(&Config{})
					listener.ReCreateHTTP(0, tunnel.Tunnel)
				})
				oldProxy := generationAddress(t)
				var payload string
				if method == http.MethodPut {
					payload = fmt.Sprintf(`{"payload":%q}`, fmt.Sprintf("port: %d\nmode: direct\nbind-address: 127.0.0.1\n", generationPort(t, oldProxy)))
				} else {
					payload = fmt.Sprintf(`{"port":%d}`, generationPort(t, oldProxy))
				}
				body := &generationDelayedBody{make(chan struct{}), make(chan struct{}), strings.NewReader(payload), false}
				request, _ := http.NewRequest(method, "/configs?force=true", body)
				request.Header.Set("Content-Type", "application/json")
				response := httptest.NewRecorder()
				done := make(chan struct{})
				go func() { oldRouter.ServeHTTP(response, request); close(done) }()
				generationWait(t, body.entered, "old request body decoding")
				stopped := make(chan struct{})
				go func() { ReCreateServer(&Config{}); close(stopped) }()
				select {
				case <-stopped:
				case <-time.After(time.Second):
					close(body.release)
					t.Fatal("controller stop waited for parsing outside mutation phase")
				}
				var currentProxy string
				if recreate {
					ReCreateServer(&Config{Addr: address})
					currentProxy = generationAddress(t)
					currentRequest, _ := http.NewRequest(http.MethodPatch, "/configs", strings.NewReader(fmt.Sprintf(`{"port":%d}`, generationPort(t, currentProxy))))
					currentResponse := httptest.NewRecorder()
					httpServer.Handler.ServeHTTP(currentResponse, currentRequest)
					if currentResponse.Code != http.StatusNoContent {
						t.Fatalf("new controller mutation failed: %d %s", currentResponse.Code, currentResponse.Body.String())
					}
				}
				close(body.release)
				generationWait(t, done, "old handler completion")
				if response.Code != http.StatusServiceUnavailable {
					t.Fatalf("stale %s returned %d instead of rejecting its stopped generation: %s", method, response.Code, response.Body.String())
				}
				generationAssertPort(t, oldProxy, false)
				if recreate {
					generationAssertPort(t, currentProxy, true)
				}
			})
		}
	}
}

// This is the FIFO reproduction with an observable handler completion. It
// checks invalidation after the raw file read, before parsing changes globals.
func TestControllerGenerationRejectsParsedOldPUT(t *testing.T) {
	directory := t.TempDir()
	C.SetHomeDir(directory)
	fifo := filepath.Join(directory, "delayed.yaml")
	if err := syscall.Mkfifo(fifo, 0600); err != nil {
		t.Fatal(err)
	}
	address := generationAddress(t)
	ReCreateServer(&Config{Addr: address})
	oldRouter := httpServer.Handler
	t.Cleanup(func() { ReCreateServer(&Config{}); listener.ReCreateHTTP(0, tunnel.Tunnel) })
	request, _ := http.NewRequest(http.MethodPut, "/configs?force=true", strings.NewReader(fmt.Sprintf(`{"path":%q}`, fifo)))
	response := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { oldRouter.ServeHTTP(response, request); close(done) }()
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
		t.Fatal("old PUT did not reach FIFO parsing")
	}
	defer writer.Close()
	ReCreateServer(&Config{})
	ReCreateServer(&Config{Addr: address})
	oldProxy := generationAddress(t)
	if _, err := fmt.Fprintf(writer, "port: %d\nmode: direct\nbind-address: 127.0.0.1\n", generationPort(t, oldProxy)); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	generationWait(t, done, "parsed old PUT completion")
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("parsed old PUT returned %d: %s", response.Code, response.Body.String())
	}
	generationAssertPort(t, oldProxy, false)
}

// Provider HTTP initialization runs inside ApplyConfig, after listener changes.
// Its barrier proves Stop waits for entered mutations before releasing sockets.
func TestControllerRecreateWaitsForEnteredMutation(t *testing.T) {
	C.SetHomeDir(t.TempDir())
	entered, release := make(chan struct{}), make(chan struct{})
	provider := stdhttptest.NewServer(stdhttp.HandlerFunc(func(w stdhttp.ResponseWriter, r *stdhttp.Request) {
		close(entered)
		<-release
		_, _ = io.WriteString(w, "proxies:\n  - name: direct\n    type: direct\n")
	}))
	defer provider.Close()
	address := generationAddress(t)
	ReCreateServer(&Config{Addr: address})
	oldRouter := httpServer.Handler
	t.Cleanup(func() { ReCreateServer(&Config{}); listener.ReCreateHTTP(0, tunnel.Tunnel) })
	proxy := generationAddress(t)
	yaml := fmt.Sprintf("port: %d\nmode: direct\nbind-address: 127.0.0.1\nproxy-providers:\n  blocked:\n    type: http\n    url: %s\n    path: blocked.yaml\n    interval: 0\n    health-check:\n      enable: false\n", generationPort(t, proxy), provider.URL)
	request, _ := http.NewRequest(http.MethodPut, "/configs?force=true", bytes.NewBufferString(fmt.Sprintf(`{"payload":%q}`, yaml)))
	response := httptest.NewRecorder()
	mutated := make(chan struct{})
	go func() { oldRouter.ServeHTTP(response, request); close(mutated) }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		close(release)
		t.Fatalf("PUT never entered provider initialization; response=%v", response)
	}
	generationAssertPort(t, proxy, true)
	stopped := make(chan struct{})
	go func() { ReCreateServer(&Config{}); close(stopped) }()
	select {
	case <-stopped:
		close(release)
		generationWait(t, mutated, "entered mutation cleanup")
		t.Fatal("controller stop returned before its entered configuration mutation exited")
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	generationWait(t, mutated, "entered mutation completion")
	generationWait(t, stopped, "controller invalidation barrier completion")
	if response.Code != http.StatusNoContent {
		t.Fatalf("active PUT failed: %d %s", response.Code, response.Body.String())
	}
	listener.ReCreateHTTP(0, tunnel.Tunnel)
	generationAssertPort(t, proxy, false)
}

// TLS certificate loading pauses ParseRawConfig after temporaryUpdateGeneral.
// ReCreate must wait for parsing and its rollback before a new generation can
// set Global mode; a stale rollback must never restore the old Rule snapshot.
func TestControllerRecreateWaitsForParserRollback(t *testing.T) {
	C.SetHomeDir(t.TempDir())
	tunnel.SetMode(tunnel.Rule)
	fifo := filepath.Join(C.Path.HomeDir(), "delayed-client-cert.pem")
	if err := syscall.Mkfifo(fifo, 0600); err != nil {
		t.Fatal(err)
	}
	address := generationAddress(t)
	ReCreateServer(&Config{Addr: address})
	oldRouter := httpServer.Handler
	t.Cleanup(func() { ReCreateServer(&Config{}) })
	yaml := fmt.Sprintf("mode: direct\nproxies:\n  - name: blocked\n    type: http\n    server: 127.0.0.1\n    port: 443\n    tls: true\n    certificate: %s\n    private-key: absent-key.pem\n", fifo)
	request, _ := http.NewRequest(http.MethodPut, "/configs?force=true", strings.NewReader(fmt.Sprintf(`{"payload":%q}`, yaml)))
	response := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { oldRouter.ServeHTTP(response, request); close(done) }()
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
		t.Fatal("old PUT did not reach TLS certificate FIFO")
	}
	defer writer.Close()
	// FIFO loading is ordered after temporaryUpdateGeneral in the real parser.
	// Observe Mode only after handler completion, which establishes Go ordering.
	stopped := make(chan struct{})
	go func() { ReCreateServer(&Config{}); close(stopped) }()
	prematureStop := false
	select {
	case <-stopped:
		prematureStop = true
	case <-time.After(100 * time.Millisecond):
	}
	setCurrentMode := func() {
		ReCreateServer(&Config{Addr: address})
		currentRequest, _ := http.NewRequest(http.MethodPatch, "/configs", strings.NewReader(`{"mode":"global"}`))
		currentResponse := httptest.NewRecorder()
		httpServer.Handler.ServeHTTP(currentResponse, currentRequest)
		if currentResponse.Code != http.StatusNoContent || tunnel.Mode() != tunnel.Global {
			t.Fatalf("new PATCH failed: %d mode=%s", currentResponse.Code, tunnel.Mode())
		}
	}
	// On the broken implementation this reproduces a new-generation PATCH
	// while the old parser still holds its previous global snapshot.
	if prematureStop {
		setCurrentMode()
	}
	if _, err := writer.WriteString("invalid certificate\n"); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	generationWait(t, done, "old TLS parser rollback completion")
	generationWait(t, stopped, "controller parser barrier completion")
	if !prematureStop {
		if tunnel.Mode() != tunnel.Rule {
			t.Fatalf("parser did not restore its original mode before Stop returned: %s", tunnel.Mode())
		}
		setCurrentMode()
	}
	if response.Code != http.StatusBadRequest {
		t.Fatalf("invalid TLS certificate should reject PUT: %d %s", response.Code, response.Body.String())
	}
	if tunnel.Mode() != tunnel.Global {
		t.Fatalf("old parser rollback overwrote new Global mode with %s", tunnel.Mode())
	}
	if prematureStop {
		t.Fatal("controller stop returned before parser rollback exited")
	}
}

func TestControllerConfigurationFileReadSemantics(t *testing.T) {
	directory := t.TempDir()
	C.SetHomeDir(directory)
	ReCreateServer(&Config{Addr: generationAddress(t)})
	t.Cleanup(func() { ReCreateServer(&Config{}) })
	empty := filepath.Join(directory, "empty.yaml")
	valid := filepath.Join(directory, "valid.yaml")
	if err := os.WriteFile(empty, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(valid, []byte("mode: global\n"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name, path, errorText string
		status                int
	}{
		{"empty", empty, "configuration file " + empty + " is empty", http.StatusBadRequest},
		{"missing", filepath.Join(directory, "missing.yaml"), "no such file", http.StatusBadRequest},
		{"relative", "relative.yaml", "path is not a absolute path", http.StatusBadRequest},
		{"unsafe", filepath.Join(filepath.Dir(directory), "unsafe-config.yaml"), "", http.StatusBadRequest},
		{"valid", valid, "", http.StatusNoContent},
	} {
		t.Run(test.name, func(t *testing.T) {
			request, _ := http.NewRequest(http.MethodPut, "/configs", strings.NewReader(fmt.Sprintf(`{"path":%q}`, test.path)))
			response := httptest.NewRecorder()
			httpServer.Handler.ServeHTTP(response, request)
			if response.Code != test.status || !strings.Contains(response.Body.String(), test.errorText) {
				t.Fatalf("file request changed semantics: status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
	if tunnel.Mode() != tunnel.Global {
		t.Fatalf("valid path was not applied: %s", tunnel.Mode())
	}
}

func generationWait(t *testing.T, done <-chan struct{}, stage string) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out waiting for %s", stage)
	}
}

func generationAddress(t *testing.T) string {
	t.Helper()
	socket, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := socket.Addr().String()
	_ = socket.Close()
	return address
}

func generationPort(t *testing.T, address string) int {
	t.Helper()
	_, port, err := net.SplitHostPort(address)
	if err != nil {
		t.Fatal(err)
	}
	var result int
	if _, err := fmt.Sscan(port, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func generationAssertPort(t *testing.T, address string, bound bool) {
	t.Helper()
	socket, err := net.Listen("tcp4", address)
	if err == nil {
		_ = socket.Close()
	}
	if bound && err == nil {
		t.Fatalf("current proxy lost listener at %s", address)
	}
	if !bound && err != nil {
		t.Fatalf("old configuration opened proxy at %s: %v", address, err)
	}
}
