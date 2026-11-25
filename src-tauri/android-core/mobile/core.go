package mobile

import (
	"errors"
	"fmt"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/metacubex/mihomo/component/dialer"
	"github.com/metacubex/mihomo/config"
	"github.com/metacubex/mihomo/constant"
	"github.com/metacubex/mihomo/dns"
	"github.com/metacubex/mihomo/hub"
	"github.com/metacubex/mihomo/hub/executor"
	"github.com/metacubex/mihomo/hub/route"
	"github.com/metacubex/mihomo/listener"
	listenerConfig "github.com/metacubex/mihomo/listener/config"
	"github.com/metacubex/mihomo/listener/sing_tun"
	"github.com/metacubex/mihomo/log"
	"github.com/metacubex/mihomo/tunnel"
	"github.com/metacubex/mihomo/tunnel/statistic"
)

// SocketProtector is implemented by the Android service that owns the VPN.
type SocketProtector interface {
	Protect(fd int32) bool
}

var (
	lifecycle sync.Mutex
	tun       *sing_tun.Listener
	home      string
	protector struct {
		sync.RWMutex
		value SocketProtector
	}
	logBuffer struct {
		sync.Mutex
		lines []string
	}
)

func init() {
	// Keep the hook installed once, so existing dial goroutines never race with a write.
	dialer.DefaultSocketHook = func(network, address string, socket syscall.RawConn) error {
		protector.RLock()
		current := protector.value
		protector.RUnlock()
		if current == nil {
			return nil
		}
		ok := false
		if err := socket.Control(func(fd uintptr) { ok = current.Protect(int32(fd)) }); err != nil {
			return err
		}
		if !ok {
			return errors.New("VPN could not protect the outbound socket")
		}
		return nil
	}
	statistic.DefaultManager.ResetStatistic()
	events := log.Subscribe()
	go func() {
		for event := range events {
			line := fmt.Sprintf("time=%q level=%s msg=%q", time.Now().Format(time.RFC3339), event.Type(), event.Payload)
			if len(line) > 2048 {
				line = line[:2048]
			}
			logBuffer.Lock()
			if len(logBuffer.lines) == 512 {
				copy(logBuffer.lines, logBuffer.lines[1:])
				logBuffer.lines = logBuffer.lines[:511]
			}
			logBuffer.lines = append(logBuffer.lines, line)
			logBuffer.Unlock()
		}
	}()
}

func readConfig(path string) (*config.Config, error) {
	dir := filepath.Dir(path)
	if home == "" {
		home = dir
		constant.SetHomeDir(dir)
	} else if dir != home {
		return nil, errors.New("Invalid configuration directory")
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if err := ensureGeodata(dir); err != nil {
		return nil, fmt.Errorf("无法准备内置规则数据，请检查存储空间或重新安装：%w", err)
	}
	return executor.ParseWithBytes(contents)
}

func Validate(path string) error {
	lifecycle.Lock()
	defer lifecycle.Unlock()
	_, err := readConfig(path)
	return err
}

func Start(path string, fd int32, callback SocketProtector) error {
	lifecycle.Lock()
	defer lifecycle.Unlock()
	if tun != nil {
		return errors.New("VPN is already connected")
	}
	if fd < 0 || callback == nil {
		return errors.New("VPN interface is unavailable")
	}
	// The service retains its descriptor; the TUN listener takes ownership of a duplicate.
	duplicate, err := syscall.Dup(int(fd))
	if err != nil {
		return err
	}
	protector.Lock()
	protector.value = callback
	protector.Unlock()
	cfg, err := readConfig(path)
	if err != nil {
		_ = syscall.Close(duplicate)
		clearProtector()
		return err
	}
	hub.ApplyConfig(cfg)
	tun, err = sing_tun.New(listenerConfig.Tun{
		Enable: true, Device: "PPClash", FileDescriptor: duplicate,
		Stack: constant.TunGvisor, MTU: 1500, DNSHijack: []string{"any:53"},
		Inet4Address: []netip.Prefix{netip.MustParsePrefix("172.19.0.1/30")},
		Inet6Address: []netip.Prefix{netip.MustParsePrefix("fdfe:dcba:9876::1/126")},
	}, tunnel.Tunnel)
	if err != nil {
		stopCore()
		return err
	}
	return nil
}

func clearProtector() {
	protector.Lock()
	protector.value = nil
	protector.Unlock()
}

func stopCore() {
	// Invalidate controller generations and wait for entered configuration
	// parsing/mutations before closing the listeners they can recreate.
	route.ReCreateServer(&route.Config{})
	if tun != nil {
		_ = tun.Close()
		tun = nil
	}
	statistic.DefaultManager.Range(func(connection statistic.Tracker) bool {
		_ = connection.Close()
		return true
	})
	executor.Shutdown()
	// Mihomo's process shutdown only closes its TUN listener. Android keeps this
	// process alive after disconnect, so every configured inbound must be closed.
	listener.ReCreateHTTP(0, tunnel.Tunnel)
	listener.ReCreateSocks(0, tunnel.Tunnel)
	listener.ReCreateRedir(0, tunnel.Tunnel)
	listener.ReCreateTProxy(0, tunnel.Tunnel)
	listener.ReCreateMixed(0, tunnel.Tunnel)
	listener.ReCreateShadowSocks("", tunnel.Tunnel)
	listener.ReCreateVmess("", tunnel.Tunnel)
	listener.ReCreateTuic(listenerConfig.TuicServer{}, tunnel.Tunnel)
	listener.PatchTunnel(nil, tunnel.Tunnel)
	listener.PatchInboundListeners(nil, tunnel.Tunnel, true)
	dns.ReCreateServer("", nil, nil)
	clearProtector()
}

func Stop() {
	lifecycle.Lock()
	defer lifecycle.Unlock()
	stopCore()
}

func Version() string { return constant.Version }

func Logs(lines int32) string {
	logBuffer.Lock()
	defer logBuffer.Unlock()
	count := min(max(int(lines), 0), len(logBuffer.lines))
	return strings.Join(logBuffer.lines[len(logBuffer.lines)-count:], "\n")
}
