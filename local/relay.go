package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const relayFrame = 32 << 10

func relayRules(text string) ([]string, error) {
	rules := []string{}
	seen := map[string]bool{}
	for _, line := range strings.Split(text, "\n") {
		line = strings.ToLower(strings.TrimSpace(line))
		if line == "" {
			continue
		}
		host, ports := line, []string{"80", "443"}
		if strings.Contains(line, ":") {
			parts := strings.Split(line, ":")
			if len(parts) != 2 {
				return nil, fmt.Errorf("规则必须是精确域名或域名:端口")
			}
			host, ports = parts[0], parts[1:]
		}
		if !validRelayHost(host) {
			return nil, fmt.Errorf("无效域名：只支持精确 ASCII 域名，不支持 URL、IP、通配符或 localhost")
		}
		for _, value := range ports {
			port, err := strconv.Atoi(value)
			if err != nil || len(value) > 5 || strings.Trim(value, "0123456789") != "" || port < 1 || port > 65535 {
				return nil, fmt.Errorf("端口必须是 1–65535")
			}
			rule := net.JoinHostPort(host, strconv.Itoa(port))
			if !seen[rule] {
				rules = append(rules, rule)
				seen[rule] = true
			}
		}
	}
	if len(rules) > 64 {
		return nil, fmt.Errorf("最多配置 64 条域名端口规则")
	}
	sort.Strings(rules)
	return rules, nil
}
func validRelayHost(host string) bool {
	if len(host) == 0 || len(host) > 253 || net.ParseIP(host) != nil || host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return false
	}
	for _, label := range strings.Split(host, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, c := range label {
			if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
				return false
			}
		}
	}
	return true
}
func relayIPAllowed(ip net.IP) bool {
	return ip.IsGlobalUnicast() && !ip.IsLoopback() && !ip.IsLinkLocalUnicast() && !ip.IsLinkLocalMulticast()
}
func dialRelay(ctx context.Context, host string, port int) (net.Conn, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	addresses, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	if len(addresses) == 0 {
		return nil, fmt.Errorf("域名没有可用地址")
	}
	for _, addr := range addresses {
		if !relayIPAllowed(addr.IP) {
			return nil, fmt.Errorf("禁止中继回环、链路本地或特殊用途地址")
		}
	}
	// Resolve once and dial the checked IP, not the hostname (DNS rebinding).
	for _, addr := range addresses {
		var conn net.Conn
		conn, err = (&net.Dialer{}).DialContext(ctx, "tcp", net.JoinHostPort(addr.IP.String(), strconv.Itoa(port)))
		if err == nil {
			return conn, nil
		}
	}
	return nil, err
}

// relayTarget is one server-requested TCP destination; Fallback means the server could not dial it itself.
type relayTarget struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Fallback bool   `json:"fallback"`
}

// relayPermits: 规则里的域名永远接；其它域名只在开关允许、且服务端说明是直连失败后的兜底时才接。
func relayPermits(rules []string, enabled bool, target relayTarget) bool {
	if !enabled {
		return false
	}
	for _, rule := range rules {
		if rule == net.JoinHostPort(target.Host, strconv.Itoa(target.Port)) {
			return true
		}
	}
	return target.Fallback
}

// Called with a.mu held. Each account has its own policy epoch; saving cancels old tunnels.
func (a *Agent) configureRelay(connection *directConnection, saved ServerCredential, parent context.Context) {
	runner := connection.jobs
	runner.mu.Lock()
	defer runner.mu.Unlock()
	if runner.relayCancel != nil {
		runner.relayCancel()
	}
	ctx, cancel := context.WithCancel(parent)
	runner.relayCancel = cancel
	rules := append([]string{}, saved.Relay...)
	// 规则全量上报：开关关掉时服务端仍要按规则拒绝直连，只是不再当出口。
	runner.relayRules = rules
	runner.relayOn = saved.relayAllowed()
	enabled := runner.relayOn
	slots := make(chan struct{}, 64)
	runner.relay = func(session context.Context, request job) {
		select {
		case slots <- struct{}{}:
		default:
			return
		}
		defer func() { <-slots }()
		flow, stop := context.WithCancel(ctx)
		defer stop()
		release := context.AfterFunc(session, stop)
		defer release()
		var target relayTarget
		// 无效目标、规则外的域名和关闭的开关都只记一条日志，不让中继变成通用代理。
		if len(request.ID) != 36 || json.Unmarshal(request.Args, &target) != nil || !validRelayHost(target.Host) {
			fmt.Fprintln(os.Stderr, "vega-local: relay ignored invalid target")
			return
		}
		if !relayPermits(rules, enabled, target) {
			fmt.Fprintf(os.Stderr, "vega-local: relay denied %s (switch %v, fallback %v)\n", net.JoinHostPort(target.Host, strconv.Itoa(target.Port)), enabled, target.Fallback)
			return
		}
		address, _ := url.Parse(saved.Origin + "/api/local-agent/relay")
		// 隧道只有一条连接：下行 SSE 收到中继帧，上行同一地址 POST 帧。
		ws, response, err := DialContext(flow, address.String(), http.Header{"Authorization": {"Bearer " + connection.token}, "X-Vega-Relay": {request.ID}})
		if err != nil {
			if response != nil {
				_ = response.Body.Close()
			}
			fmt.Fprintf(os.Stderr, "vega-local: relay channel %s failed: %v\n", address.String(), err)
			return
		}
		defer ws.Close()
		closeWS := context.AfterFunc(flow, func() { _ = ws.Close() })
		defer closeWS()
		remote, err := dialRelay(flow, target.Host, target.Port)
		if err != nil {
			fmt.Fprintf(os.Stderr, "vega-local: relay dial %s failed: %v\n", net.JoinHostPort(target.Host, strconv.Itoa(target.Port)), err)
			return
		}
		defer remote.Close()
		pumpRelay(flow, remote, ws)
	}
}
func pumpRelay(ctx context.Context, remote net.Conn, ws *Conn) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	cleanup := context.AfterFunc(ctx, func() { _ = remote.Close(); _ = ws.Close() })
	defer cleanup()
	var mu sync.Mutex
	send := func(data []byte) error {
		mu.Lock()
		defer mu.Unlock()
		_ = ws.SetWriteDeadline(time.Now().Add(30 * time.Second))
		return ws.WriteMessage(BinaryMessage, data)
	}
	ws.SetReadLimit(relayFrame + 1)
	if send([]byte{2}) != nil {
		return
	}
	acknowledgements := make(chan struct{}, 1)
	var outstanding atomic.Bool
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer cancel()
		buffer := make([]byte, relayFrame+1)
		for {
			_ = remote.SetReadDeadline(time.Now().Add(5 * time.Minute))
			n, err := remote.Read(buffer[1:])
			if n > 0 {
				buffer[0] = 0
				outstanding.Store(true)
				if send(buffer[:n+1]) != nil {
					return
				}
				timer := time.NewTimer(30 * time.Second)
				select {
				case <-acknowledgements:
					timer.Stop()
				case <-timer.C:
					return
				case <-ctx.Done():
					timer.Stop()
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()
	defer func() { cancel(); <-done }()
	for {
		_ = ws.SetReadDeadline(time.Now().Add(5 * time.Minute))
		kind, data, err := ws.ReadMessage()
		if err != nil || kind != BinaryMessage || len(data) == 0 {
			return
		}
		if data[0] == 1 && len(data) == 1 {
			if !outstanding.CompareAndSwap(true, false) {
				return
			}
			select {
			case acknowledgements <- struct{}{}:
			default:
				return
			}
		} else if data[0] == 0 && len(data) > 1 {
			_ = remote.SetWriteDeadline(time.Now().Add(30 * time.Second))
			if _, err = io.Copy(remote, bytes.NewReader(data[1:])); err != nil || send([]byte{1}) != nil {
				return
			}
		} else {
			return
		}
	}
}

func (a *Agent) saveRelay(origin, userID, text string, enabled bool) error {
	rules, err := relayRules(text)
	if err != nil {
		return err
	}
	a.mu.Lock()
	if a.updating {
		a.mu.Unlock()
		return fmt.Errorf("客户端正在更新，请稍后再试")
	}
	next := a.config
	next.Servers = append([]ServerCredential{}, a.config.Servers...)
	index := -1
	for i, saved := range next.Servers {
		if saved.Origin == origin && saved.UserID == userID {
			index = i
			break
		}
	}
	if index < 0 {
		a.mu.Unlock()
		return fmt.Errorf("账号尚未配对")
	}
	on := enabled
	next.Servers[index].Relay = rules
	next.Servers[index].RelayOn = &on
	if err = a.saveConfig(next); err != nil {
		a.mu.Unlock()
		return fmt.Errorf("中继配置未保存：%w", err)
	}
	a.config = next
	connection := a.direct[origin+"\x00"+userID]
	if connection != nil {
		parent := a.context
		if parent == nil {
			parent = context.Background()
		}
		a.configureRelay(connection, next.Servers[index], parent)
	}
	a.mu.Unlock()
	if connection != nil {
		runner := connection.jobs
		runner.mu.Lock()
		runner.write(map[string]any{"type": "ping", "relay": runner.relayRules})
		runner.mu.Unlock()
	}
	return nil
}
