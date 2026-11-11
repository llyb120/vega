package main

// 测试用的实时通道两端：假服务端（SSE 下行 + POST 上行）和假网页（POST 票据 + 读 SSE 状态）。

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type upstream struct {
	raw    []byte // 文本消息原文
	binary []byte // 中继帧（已解码）
}

// channelPeer 是一条假通道：测试用它收上行、发下行。
type channelPeer struct {
	channel  string
	ctx      context.Context
	up       chan upstream
	down     chan []byte
	stopped  chan struct{}
	stopOnce sync.Once
}

func (peer *channelPeer) send(value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return peer.push(data)
}

func (peer *channelPeer) sendFrame(data []byte) error {
	return peer.send(map[string]string{"type": "relay", "data": base64.StdEncoding.EncodeToString(data)})
}

func (peer *channelPeer) push(data []byte) error {
	select {
	case peer.down <- data:
		return nil
	case <-peer.stopped:
		return errClosed
	case <-peer.ctx.Done():
		return errClosed
	}
}

// poll 取一条上行消息，供服务端回调（不在测试 goroutine 里）使用。
func (peer *channelPeer) poll() (upstream, bool) {
	select {
	case frame := <-peer.up:
		return frame, true
	case <-peer.stopped:
	case <-peer.ctx.Done():
	case <-time.After(10 * time.Second):
	}
	return upstream{}, false
}

func (peer *channelPeer) stop() { peer.stopOnce.Do(func() { close(peer.stopped) }) }

// channelServer 把所有请求都当同一条通道处理：GET 写 SSE，POST 收上行。
// accept 在通道建立后调用（握手就在里面做），返回后等下行流结束。
type channelServer struct {
	accept func(peer *channelPeer, r *http.Request)
	seq    atomic.Int64
	mu     sync.Mutex
	peers  map[string]*channelPeer
	latest *channelPeer
}

func newChannelServer(accept func(peer *channelPeer, r *http.Request)) *channelServer {
	return &channelServer{accept: accept, peers: map[string]*channelPeer{}}
}

func (server *channelServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		server.upstream(w, r)
		return
	}
	flush, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	peer := &channelPeer{channel: "channel-" + strconv.FormatInt(server.seq.Add(1), 10), ctx: r.Context(),
		up: make(chan upstream, 64), down: make(chan []byte, 64), stopped: make(chan struct{})}
	server.mu.Lock()
	server.peers[peer.channel], server.latest = peer, peer
	server.mu.Unlock()
	defer func() {
		server.mu.Lock()
		delete(server.peers, peer.channel)
		server.mu.Unlock()
	}()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	if !writeEvent(w, flush, fmt.Sprintf(`{"type":"channel","channel":%q}`, peer.channel)) {
		return
	}
	writer := make(chan struct{})
	go func() {
		defer close(writer)
		for {
			select {
			case data := <-peer.down:
				if !writeEvent(w, flush, string(data)) {
					return
				}
			case <-peer.stopped:
				// 先把手已排好的帧写完，再结束响应：客户端靠这些帧收尾。
				for {
					select {
					case data := <-peer.down:
						if !writeEvent(w, flush, string(data)) {
							return
						}
					default:
						return
					}
				}
			case <-r.Context().Done():
				return
			}
		}
	}()
	if server.accept != nil {
		server.accept(peer, r)
	}
	// 服务端回调返回就等于关掉这条流（与旧版 handler 返回即断开一致）。
	peer.stop()
	<-writer
}

func (server *channelServer) upstream(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 64<<20))
	if err != nil {
		http.Error(w, "unreadable body", http.StatusBadRequest)
		return
	}
	var envelope struct {
		Channel string          `json:"channel"`
		Message json.RawMessage `json:"message"`
		Data    *string         `json:"data"`
	}
	if json.Unmarshal(body, &envelope) != nil {
		http.Error(w, "invalid envelope", http.StatusBadRequest)
		return
	}
	frame := upstream{raw: envelope.Message}
	if envelope.Data != nil {
		if frame.binary, err = base64.StdEncoding.DecodeString(*envelope.Data); err != nil {
			http.Error(w, "invalid frame", http.StatusBadRequest)
			return
		}
	}
	peer := server.peer(envelope.Channel)
	if peer == nil {
		http.Error(w, "unknown channel", http.StatusNotFound)
		return
	}
	select {
	case peer.up <- frame:
	case <-peer.ctx.Done():
	}
	_, _ = w.Write([]byte(`{"ok":true}`))
}

func (server *channelServer) peer(channel string) *channelPeer {
	server.mu.Lock()
	defer server.mu.Unlock()
	if channel != "" {
		return server.peers[channel]
	}
	// 中继隧道不带 channel 参数：一次只有一条。
	return server.latest
}

func writeEvent(w io.Writer, flush http.Flusher, payload string) bool {
	if _, err := w.Write([]byte("data: " + payload + "\n\n")); err != nil {
		return false
	}
	flush.Flush()
	return true
}

// pairingClient 和网页一样：POST 一条登录票据，然后读客户端推回来的 SSE 状态。
type pairingClient struct {
	body   io.ReadCloser
	frames chan map[string]any
	errs   chan error
}

func dialPairing(t *testing.T, serverURL, origin string, auth any) *pairingClient {
	t.Helper()
	body, err := json.Marshal(auth)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost, serverURL+"/agent", strings.NewReader(string(body)))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "text/plain")
	request.Header.Set("Origin", origin)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK {
		_ = response.Body.Close()
		t.Fatalf("pairing endpoint answered HTTP %d", response.StatusCode)
	}
	client := &pairingClient{body: response.Body, frames: make(chan map[string]any, 16), errs: make(chan error, 1)}
	go client.pump()
	return client
}

func (client *pairingClient) pump() {
	reader := bufio.NewReader(client.body)
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			client.errs <- err
			return
		}
		line = strings.TrimRight(line, "\r\n")
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		var value map[string]any
		if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &value); err != nil {
			client.errs <- err
			return
		}
		client.frames <- value
	}
}

func (client *pairingClient) next(t *testing.T) map[string]any {
	t.Helper()
	select {
	case value := <-client.frames:
		return value
	case err := <-client.errs:
		t.Fatalf("pairing stream ended: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("pairing stream stalled")
	}
	return nil
}

func (client *pairingClient) close() { _ = client.body.Close() }
