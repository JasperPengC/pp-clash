package mobile

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/metacubex/mihomo/adapter/inbound"
	C "github.com/metacubex/mihomo/constant"
	"github.com/metacubex/mihomo/dns"
	"github.com/metacubex/mihomo/hub/route"
	"github.com/metacubex/mihomo/listener"
	LC "github.com/metacubex/mihomo/listener/config"
	"github.com/metacubex/mihomo/tunnel"
	D "github.com/miekg/dns"
)

// Mihomo listener registries are process globals. Keep their real sockets and
// stop/start transitions in a child, away from other tests and application data.
func TestStopCoreReleasesRealListenerSocketsInSubprocess(t *testing.T) {
	const childFlag = "PPCLASH_STOP_CORE_SOCKET_CHILD"
	if os.Getenv(childFlag) != "1" {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		command := exec.CommandContext(ctx, os.Args[0],
			"-test.run=^TestStopCoreReleasesRealListenerSocketsInSubprocess$", "-test.v")
		command.Env = append(os.Environ(), childFlag+"=1")
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("isolated real-socket stop test failed: %v\n%s", err, output)
		}
		t.Logf("isolated real-socket stop test:\n%s", output)
		return
	}

	C.SetHomeDir(t.TempDir())
	listener.SetAllowLan(false)
	listener.SetBindAddress("127.0.0.1")
	addresses := make(map[string]string)
	reserved := make(map[string]bool)
	for _, name := range []string{"http", "socks", "mixed", "named-mixed", "forward-tunnel", "dns", "controller"} {
		for {
			address := reserveStopTestAddress(t)
			if !reserved[address] {
				addresses[name] = address
				reserved[address] = true
				break
			}
		}
	}
	var sockets []stopTestSocket
	for _, name := range []string{"http", "socks", "mixed", "named-mixed", "forward-tunnel", "dns", "controller"} {
		sockets = append(sockets, stopTestSocket{name, "tcp4", addresses[name]})
		if name != "http" && name != "controller" {
			sockets = append(sockets, stopTestSocket{name, "udp4", addresses[name]})
		}
	}

	for round := 1; round <= 2; round++ {
		listener.ReCreateHTTP(stopTestPort(t, addresses["http"]), tunnel.Tunnel)
		listener.ReCreateSocks(stopTestPort(t, addresses["socks"]), tunnel.Tunnel)
		listener.ReCreateMixed(stopTestPort(t, addresses["mixed"]), tunnel.Tunnel)
		named, err := listener.ParseListener(map[string]any{
			"name": "stop-test-mixed", "type": "mixed", "listen": "127.0.0.1",
			"port": stopTestPort(t, addresses["named-mixed"]), "udp": true,
		})
		if err != nil {
			t.Fatalf("parse real named listener: %v", err)
		}
		listener.PatchInboundListeners(map[string]C.InboundListener{"stop-test-mixed": named}, tunnel.Tunnel, true)
		listener.PatchTunnel([]LC.Tunnel{{Network: []string{"tcp", "udp"},
			Address: addresses["forward-tunnel"], Target: "127.0.0.1:1", Proxy: "DIRECT"}}, tunnel.Tunnel)
		// No DNS upstream is configured. Readiness probes use empty questions,
		// which yield a local error response without an upstream lookup.
		service := dns.NewService(dns.NewResolver(dns.Config{}).Resolver, dns.NewEnhancer(dns.EnhancerConfig{}))
		dns.ReCreateServer(addresses["dns"], inbound.NewListenConfig(), service)
		route.ReCreateServer(&route.Config{Addr: addresses["controller"], Secret: "synthetic-stop-test"})

		awaitStopTestSockets(t, sockets, true, 5*time.Second)
		awaitStopTestProtocolReady(t, addresses["controller"], addresses["dns"])
		t.Logf("round %d: all %d real TCP/UDP sockets are bound before stopCore", round, len(sockets))
		stopCore()
		awaitStopTestSockets(t, sockets, false, 2*time.Second)
		t.Logf("round %d: all %d real TCP/UDP sockets can be rebound after stopCore", round, len(sockets))
	}
}

func awaitStopTestProtocolReady(t *testing.T, controllerAddress, dnsAddress string) {
	t.Helper()
	client := &http.Client{Timeout: 500 * time.Millisecond,
		Transport: &http.Transport{Proxy: nil, DisableKeepAlives: true}}
	defer client.CloseIdleConnections()
	deadline := time.Now().Add(5 * time.Second)
	var failures []string
	for {
		failures = nil
		request, err := http.NewRequest(http.MethodGet, "http://"+controllerAddress+"/version", nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Authorization", "Bearer synthetic-stop-test")
		response, err := client.Do(request)
		if err != nil {
			failures = append(failures, "controller readiness: "+err.Error())
		} else {
			_, readError := io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
			if response.StatusCode != http.StatusOK || readError != nil {
				failures = append(failures, fmt.Sprintf("controller readiness: status=%d read=%v", response.StatusCode, readError))
			}
		}
		for _, network := range []string{"tcp", "udp"} {
			query := &D.Msg{MsgHdr: D.MsgHdr{Id: D.Id()}}
			dnsClient := &D.Client{Net: network, Timeout: 500 * time.Millisecond}
			reply, _, err := dnsClient.Exchange(query, dnsAddress)
			if err != nil || reply == nil {
				failures = append(failures, fmt.Sprintf("DNS %s readiness: %v", network, err))
			}
		}
		if len(failures) == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("real controller/DNS servers were not protocol-ready:\n%s", strings.Join(failures, "\n"))
		}
		time.Sleep(10 * time.Millisecond)
	}
}

type stopTestSocket struct {
	name, network, address string
}

func (socket stopTestSocket) bind() error {
	if socket.network == "tcp4" {
		connection, err := net.Listen(socket.network, socket.address)
		if err == nil {
			return connection.Close()
		}
		return err
	}
	connection, err := net.ListenPacket(socket.network, socket.address)
	if err == nil {
		return connection.Close()
	}
	return err
}

func awaitStopTestSockets(t *testing.T, sockets []stopTestSocket, wantBound bool, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	var failures []string
	for {
		failures = nil
		for _, socket := range sockets {
			err := socket.bind()
			if wantBound && !errors.Is(err, syscall.EADDRINUSE) {
				failures = append(failures, fmt.Sprintf("%s %s %s was not bound: %v", socket.name, socket.network, socket.address, err))
			} else if !wantBound && err != nil {
				failures = append(failures, fmt.Sprintf("%s %s %s rebind failed: %T: %v", socket.name, socket.network, socket.address, err, err))
			}
		}
		if len(failures) == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("real socket lifecycle did not settle (wantBound=%t):\n%s", wantBound, strings.Join(failures, "\n"))
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func reserveStopTestAddress(t *testing.T) string {
	t.Helper()
	for attempts := 0; attempts < 100; attempts++ {
		tcp, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		address := tcp.Addr().String()
		udp, err := net.ListenPacket("udp4", address)
		_ = tcp.Close()
		if err == nil {
			_ = udp.Close()
			return address
		}
	}
	t.Fatal("could not reserve an unused loopback TCP/UDP port")
	return ""
}

func stopTestPort(t *testing.T, address string) int {
	t.Helper()
	_, text, err := net.SplitHostPort(address)
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(text)
	if err != nil {
		t.Fatal(err)
	}
	return port
}
