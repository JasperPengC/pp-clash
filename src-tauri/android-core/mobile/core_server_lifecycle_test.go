package mobile

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"syscall"
	"testing"
	"time"

	"github.com/metacubex/mihomo/adapter/inbound"
	"github.com/metacubex/mihomo/dns"
	"github.com/metacubex/mihomo/hub/route"
	D "github.com/miekg/dns"
)

func serverLifecycleChild(t *testing.T) bool {
	t.Helper()
	const flag = "PPCLASH_SERVER_LIFECYCLE_CHILD"
	if os.Getenv(flag) == t.Name() {
		previous := runtime.GOMAXPROCS(1)
		t.Cleanup(func() { runtime.GOMAXPROCS(previous) })
		return true
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, os.Args[0], "-test.run=^"+t.Name()+"$", "-test.v")
	command.Env = append(os.Environ(), flag+"="+t.Name())
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("isolated lifecycle test failed: %v\n%s", err, output)
	}
	t.Logf("isolated lifecycle test:\n%s", output)
	return false
}

// Check the API's return boundary, including an immediate stop before Serve has
// had a chance to run. No sleep or eventual port-release polling masks a race.
func TestRouteServerRecreateInitializesAndStopsSynchronously(t *testing.T) {
	if !serverLifecycleChild(t) {
		return
	}
	address := reserveStopTestAddress(t)
	socket := stopTestSocket{"controller", "tcp4", address}
	client := &http.Client{Timeout: time.Second,
		Transport: &http.Transport{Proxy: nil, DisableKeepAlives: true}}
	defer client.CloseIdleConnections()
	for round := 0; round < 50; round++ {
		route.ReCreateServer(&route.Config{Addr: address, Secret: "previous"})
		assertServerSocketBoundary(t, socket, true, "controller initialization")
		route.ReCreateServer(&route.Config{})
		assertServerSocketBoundary(t, socket, false, "controller immediate stop")
		secret := fmt.Sprintf("latest-%d", round)
		route.ReCreateServer(&route.Config{Addr: address, Secret: secret})
		request, err := http.NewRequest(http.MethodGet, "http://"+address+"/version", nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Authorization", "Bearer "+secret)
		response, err := client.Do(request)
		if err != nil {
			t.Fatalf("latest controller was lost after fast stop/start: %v", err)
		}
		body, readErr := io.ReadAll(response.Body)
		_ = response.Body.Close()
		if response.StatusCode != http.StatusOK || readErr != nil || len(body) == 0 {
			t.Fatalf("latest controller config did not survive: status=%d body=%q error=%v", response.StatusCode, body, readErr)
		}
		route.ReCreateServer(&route.Config{})
		assertServerSocketBoundary(t, socket, false, "controller active stop")
	}
}

func TestDNSServerRecreateInitializesAndStopsSynchronously(t *testing.T) {
	if !serverLifecycleChild(t) {
		return
	}
	address := reserveStopTestAddress(t)
	sockets := []stopTestSocket{{"DNS", "tcp4", address}, {"DNS", "udp4", address}}
	service := dns.NewService(dns.NewResolver(dns.Config{}).Resolver, dns.NewEnhancer(dns.EnhancerConfig{}))
	for round := 0; round < 50; round++ {
		dns.ReCreateServer(address, inbound.NewListenConfig(), service)
		for _, socket := range sockets {
			assertServerSocketBoundary(t, socket, true, "DNS initialization")
		}
		dns.ReCreateServer("", nil, nil)
		for _, socket := range sockets {
			assertServerSocketBoundary(t, socket, false, "DNS immediate stop")
		}
		dns.ReCreateServer(address, inbound.NewListenConfig(), service)
		for _, network := range []string{"tcp", "udp"} {
			client := &D.Client{Net: network, Timeout: time.Second}
			query := &D.Msg{MsgHdr: D.MsgHdr{Id: D.Id()}}
			reply, _, err := client.Exchange(query, address)
			if err != nil || reply == nil {
				t.Fatalf("latest DNS %s server was lost after fast stop/start: %v", network, err)
			}
		}
		dns.ReCreateServer("", nil, nil)
		for _, socket := range sockets {
			assertServerSocketBoundary(t, socket, false, "DNS active stop")
		}
	}
}

func assertServerSocketBoundary(t *testing.T, socket stopTestSocket, wantBound bool, action string) {
	t.Helper()
	err := socket.bind()
	if wantBound && !errors.Is(err, syscall.EADDRINUSE) {
		t.Fatalf("%s returned before binding %s %s: %v", action, socket.network, socket.address, err)
	}
	if !wantBound && err != nil {
		t.Fatalf("%s returned before releasing %s %s: %v", action, socket.network, socket.address, err)
	}
}
