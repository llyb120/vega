package main

// 实时通道的传输层：下行是一条 text/event-stream，上行是同一路径上的普通 POST。
// 方法名与消息类型常量照抄 gorilla/websocket，调用方只换类型、不改逻辑。

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	TextMessage   = 1
	BinaryMessage = 2

	CloseMessageTooBig = 1009

	closeAbnormal = 1006
	// 单帧硬上限：服务端最大的结果约 48 MiB，留出 JSON 包装的余量；超过即视为对端异常。
	maxFrameBytes = 64 << 20
	// 没有设置写超时时，一次上行请求最多等这么久。
	defaultWriteTimeout = 30 * time.Second
)

var (
	errReadTimeout  = errors.New("realtime channel read deadline exceeded")
	errWriteTimeout = errors.New("realtime channel write deadline exceeded")
	errClosed       = errors.New("realtime channel closed")
)

// CloseError 是对端给出的关闭码：服务端结束通道时会先发 {"type":"closed","code":..}。
type CloseError struct {
	Code   int
	Reason string
}

func (err *CloseError) Error() string {
	if err.Reason == "" {
		return "realtime channel closed (" + strconv.Itoa(err.Code) + ")"
	}
	return "realtime channel closed (" + strconv.Itoa(err.Code) + "): " + err.Reason
}

// IsCloseError 判断错误是否携带指定关闭码，与 gorilla 同名函数一致。
func IsCloseError(err error, codes ...int) bool {
	var closed *CloseError
	if !errors.As(err, &closed) {
		return false
	}
	for _, code := range codes {
		if closed.Code == code {
			return true
		}
	}
	return false
}

type frame struct {
	kind int
	data []byte
}

// Conn 是一条实时通道：保留 gorilla/websocket 的用法，下面换成 SSE + POST。
type Conn struct {
	address string
	header  http.Header
	client  *http.Client
	ctx     context.Context
	cancel  context.CancelFunc

	frames chan frame
	ready  chan struct{} // 收到 {"type":"channel"} 后关闭：上行必须带通道 id
	done   chan struct{} // 整条通道结束（读流结束或被 Close）

	channelMu sync.Mutex
	channel   string
	readyOnce sync.Once
	stopOnce  sync.Once

	stateMu       sync.Mutex
	readDeadline  time.Time
	writeDeadline time.Time
	readLimit     int64

	writeMu sync.Mutex
	laneMu  sync.Mutex
	lanes   map[int]context.CancelFunc

	errMu sync.Mutex
	err   error
}

// Dial 打开一条实时通道；address 与上行 POST 用同一个地址。
func Dial(address string, header http.Header) (*Conn, *http.Response, error) {
	return DialContext(context.Background(), address, header)
}

func DialContext(ctx context.Context, address string, header http.Header) (*Conn, *http.Response, error) {
	ctx, cancel := context.WithCancel(ctx)
	conn := &Conn{
		address: address,
		header:  cloneHeader(header),
		client:  streamClient(),
		ctx:     ctx,
		cancel:  cancel,
		frames:  make(chan frame, 16),
		ready:   make(chan struct{}),
		done:    make(chan struct{}),
	}
	response, err := conn.open(ctx, address)
	if err != nil {
		cancel()
		return nil, response, err
	}
	go conn.read(response.Body)
	return conn, response, nil
}

func streamClient() *http.Client {
	// 不能设 Client.Timeout：它会把整条流按总时长掐掉。重定向照旧当失败上报。
	return &http.Client{
		Transport:     http.DefaultTransport,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

func cloneHeader(header http.Header) http.Header {
	if header == nil {
		return http.Header{}
	}
	return header.Clone()
}

func copyHeader(target, source http.Header) {
	for name, values := range source {
		for _, value := range values {
			target.Add(name, value)
		}
	}
}

func (conn *Conn) open(ctx context.Context, address string) (*http.Response, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return nil, err
	}
	copyHeader(request.Header, conn.header)
	request.Header.Set("Accept", "text/event-stream")
	response, err := conn.client.Do(request)
	if err != nil {
		return nil, err
	}
	// 只有 event-stream 才是通道；普通响应（登录失效、代理没配对、网关报错）原样交回调用方判断状态码。
	if response.StatusCode != http.StatusOK || !strings.HasPrefix(response.Header.Get("Content-Type"), "text/event-stream") {
		_ = response.Body.Close()
		return response, fmt.Errorf("realtime channel rejected: %s", response.Status)
	}
	return response, nil
}

// read 把一条下行流读完；结束原因交给 ReadMessage。
func (conn *Conn) read(body io.ReadCloser) {
	defer body.Close()
	err := conn.pump(body)
	if err == nil {
		err = &CloseError{Code: closeAbnormal}
	}
	conn.setError(err)
	conn.Close()
}

func (conn *Conn) pump(body io.Reader) error {
	reader := bufio.NewReaderSize(body, 32<<10)
	var payload []byte
	var started bool
	for {
		line, err := readLine(reader)
		if len(line) > 0 {
			text := string(bytes.TrimRight(line, "\r\n"))
			switch {
			case text == "":
				if started {
					started = false
					message := payload
					payload = nil
					if dispatchErr := conn.dispatch(message); dispatchErr != nil {
						return dispatchErr
					}
				}
			case strings.HasPrefix(text, "data:"):
				value := strings.TrimPrefix(strings.TrimPrefix(text, "data:"), " ")
				if len(payload) > 0 {
					payload = append(payload, '\n')
				}
				payload = append(payload, value...)
				started = true
			}
			// 其余行（": keepalive"、event/id/retry）与这条协议无关。
		}
		if err != nil {
			if err == io.EOF || conn.ctx.Err() != nil {
				return nil
			}
			return err
		}
	}
}

// readLine 读一整行，超过 maxFrameBytes 立刻放弃：坏对端不能靠一条超长行把内存拖爆。
func readLine(reader *bufio.Reader) ([]byte, error) {
	var line []byte
	for {
		chunk, err := reader.ReadSlice('\n')
		if len(line)+len(chunk) > maxFrameBytes {
			return nil, &CloseError{Code: CloseMessageTooBig, Reason: "frame exceeds transport limit"}
		}
		line = append(line, chunk...)
		if err == bufio.ErrBufferFull {
			continue
		}
		return line, err
	}
}

func (conn *Conn) dispatch(payload []byte) error {
	var envelope struct {
		Type    string  `json:"type"`
		Channel string  `json:"channel"`
		Open    int     `json:"open"`
		Close   int     `json:"close"`
		Code    int     `json:"code"`
		Reason  string  `json:"reason"`
		Data    *string `json:"data"`
	}
	if json.Unmarshal(payload, &envelope) != nil {
		return &CloseError{Code: closeAbnormal, Reason: "invalid realtime frame"}
	}
	switch envelope.Type {
	case "channel":
		conn.setChannel(envelope.Channel)
		return nil
	case "lane":
		if envelope.Open > 0 {
			conn.openLane(envelope.Open)
		}
		if envelope.Close > 0 {
			conn.closeLane(envelope.Close)
		}
		return nil
	case "closed":
		return &CloseError{Code: envelope.Code, Reason: envelope.Reason}
	case "relay":
		// 中继下行的二进制帧：解码后按 BinaryMessage 交给 pumpRelay。
		if envelope.Data != nil {
			data, err := base64.StdEncoding.DecodeString(*envelope.Data)
			if err != nil {
				return &CloseError{Code: closeAbnormal, Reason: "invalid relay frame"}
			}
			if limit := conn.limit(); limit > 0 && int64(len(data)) > limit {
				return &CloseError{Code: CloseMessageTooBig, Reason: "frame exceeds read limit"}
			}
			conn.deliver(frame{kind: BinaryMessage, data: data})
			return nil
		}
	}
	if limit := conn.limit(); limit > 0 && int64(len(payload)) > limit {
		return &CloseError{Code: CloseMessageTooBig, Reason: "message exceeds read limit"}
	}
	conn.deliver(frame{kind: TextMessage, data: payload})
	return nil
}

func (conn *Conn) deliver(message frame) {
	select {
	case conn.frames <- message:
	case <-conn.done:
	}
}

func (conn *Conn) setChannel(id string) {
	conn.channelMu.Lock()
	conn.channel = id
	conn.channelMu.Unlock()
	conn.readyOnce.Do(func() { close(conn.ready) })
}

func (conn *Conn) channelID() string {
	conn.channelMu.Lock()
	defer conn.channelMu.Unlock()
	return conn.channel
}

// openLane 按服务端要求扩容一条数据车道：同地址加 channel/lane 参数，请求头沿用。
func (conn *Conn) openLane(lane int) {
	conn.laneMu.Lock()
	if conn.lanes == nil {
		conn.lanes = make(map[int]context.CancelFunc)
	}
	if _, exists := conn.lanes[lane]; exists {
		conn.laneMu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(conn.ctx)
	conn.lanes[lane] = cancel
	conn.laneMu.Unlock()
	go func() {
		defer cancel()
		select {
		case <-conn.ready:
		case <-ctx.Done():
			return
		}
		separator := "?"
		if strings.Contains(conn.address, "?") {
			separator = "&"
		}
		address := conn.address + separator + "channel=" + url.QueryEscape(conn.channelID()) + "&lane=" + strconv.Itoa(lane)
		response, err := conn.open(ctx, address)
		if err != nil {
			return
		}
		defer response.Body.Close()
		_ = conn.pump(response.Body)
	}()
}

func (conn *Conn) closeLane(lane int) {
	conn.laneMu.Lock()
	cancel, ok := conn.lanes[lane]
	delete(conn.lanes, lane)
	conn.laneMu.Unlock()
	if ok {
		cancel()
	}
}

func (conn *Conn) setError(err error) {
	conn.errMu.Lock()
	if conn.err == nil {
		conn.err = err
	}
	conn.errMu.Unlock()
}

func (conn *Conn) closeError() error {
	conn.errMu.Lock()
	defer conn.errMu.Unlock()
	if conn.err != nil {
		return conn.err
	}
	return errClosed
}

// ReadMessage 交出下一条消息；读流结束时返回带着关闭码的错误。
func (conn *Conn) ReadMessage() (int, []byte, error) {
	var timeout <-chan time.Time
	conn.stateMu.Lock()
	deadline := conn.readDeadline
	conn.stateMu.Unlock()
	if !deadline.IsZero() {
		timer := time.NewTimer(time.Until(deadline))
		defer timer.Stop()
		timeout = timer.C
	}
	select {
	case message := <-conn.frames:
		return message.kind, message.data, nil
	case <-timeout:
		return 0, nil, errReadTimeout
	case <-conn.done:
		// 先把排在结束之前的消息交出去，再报结束原因。
		select {
		case message := <-conn.frames:
			return message.kind, message.data, nil
		default:
			return 0, nil, conn.closeError()
		}
	}
}

func (conn *Conn) ReadJSON(value any) error {
	_, data, err := conn.ReadMessage()
	if err != nil {
		return err
	}
	return json.Unmarshal(data, value)
}

func (conn *Conn) WriteJSON(value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return conn.WriteMessage(TextMessage, data)
}

// WriteMessage 把一条消息 POST 回服务端：文本带通道 id，二进制（中继帧）只带 data。
func (conn *Conn) WriteMessage(kind int, data []byte) error {
	var body []byte
	if kind == BinaryMessage {
		// 中继隧道只有一个车道，上行只认 {"data":"<base64 帧>"}。
		encoded, err := json.Marshal(map[string]string{"data": base64.StdEncoding.EncodeToString(data)})
		if err != nil {
			return err
		}
		body = encoded
	} else {
		channel, err := conn.waitChannel()
		if err != nil {
			return err
		}
		encoded, err := json.Marshal(struct {
			Channel string          `json:"channel"`
			Message json.RawMessage `json:"message"`
		}{Channel: channel, Message: json.RawMessage(data)})
		if err != nil {
			return err
		}
		body = encoded
	}
	return conn.post(body)
}

// waitChannel：通道 id 在下行第一条消息里，上行要等它到，不能拿空的 id 发。
func (conn *Conn) waitChannel() (string, error) {
	select {
	case <-conn.ready:
		return conn.channelID(), nil
	default:
	}
	timer := time.NewTimer(time.Until(conn.writeDeadlineAt()))
	defer timer.Stop()
	select {
	case <-conn.ready:
		return conn.channelID(), nil
	case <-conn.done:
		return "", conn.closeError()
	case <-timer.C:
		return "", errWriteTimeout
	}
}

func (conn *Conn) post(body []byte) error {
	conn.writeMu.Lock()
	defer conn.writeMu.Unlock()
	if conn.ctx.Err() != nil {
		return conn.closeError()
	}
	ctx, cancel := context.WithDeadline(conn.ctx, conn.writeDeadlineAt())
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, conn.address, bytes.NewReader(body))
	if err != nil {
		return err
	}
	copyHeader(request.Header, conn.header)
	request.Header.Set("Content-Type", "application/json")
	response, err := conn.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	detail, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
	if response.StatusCode/100 != 2 {
		return fmt.Errorf("realtime upstream rejected: HTTP %d %s", response.StatusCode, strings.TrimSpace(string(detail)))
	}
	return nil
}

func (conn *Conn) writeDeadlineAt() time.Time {
	conn.stateMu.Lock()
	defer conn.stateMu.Unlock()
	if conn.writeDeadline.IsZero() {
		return time.Now().Add(defaultWriteTimeout)
	}
	return conn.writeDeadline
}

func (conn *Conn) limit() int64 {
	conn.stateMu.Lock()
	defer conn.stateMu.Unlock()
	return conn.readLimit
}

func (conn *Conn) SetReadDeadline(deadline time.Time) error {
	conn.stateMu.Lock()
	conn.readDeadline = deadline
	conn.stateMu.Unlock()
	return nil
}

func (conn *Conn) SetWriteDeadline(deadline time.Time) error {
	conn.stateMu.Lock()
	conn.writeDeadline = deadline
	conn.stateMu.Unlock()
	return nil
}

func (conn *Conn) SetReadLimit(limit int64) {
	conn.stateMu.Lock()
	conn.readLimit = limit
	conn.stateMu.Unlock()
}

func (conn *Conn) Close() error {
	conn.stopOnce.Do(func() {
		conn.cancel()
		conn.laneMu.Lock()
		lanes := conn.lanes
		conn.lanes = nil
		conn.laneMu.Unlock()
		for _, cancel := range lanes {
			cancel()
		}
		close(conn.done)
	})
	return nil
}

// StreamWriter 是一条 SSE 响应的写端：本机配对时网页 POST 进来，客户端把状态写出去。
type StreamWriter struct {
	writer  http.ResponseWriter
	flusher http.Flusher
	mu      sync.Mutex
	closed  bool
}

// ServeStream 开始一条 SSE 响应，并带上跨源所需的响应头（text/plain 的简单请求不触发预检）。
func ServeStream(w http.ResponseWriter, r *http.Request, origin string) *StreamWriter {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Access-Control-Allow-Methods", "POST")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	w.Header().Set("Vary", "Origin")
	flusher, _ := w.(http.Flusher)
	w.WriteHeader(http.StatusOK)
	if flusher != nil {
		flusher.Flush()
	}
	return &StreamWriter{writer: w, flusher: flusher}
}

func (stream *StreamWriter) WriteMessage(_ int, data []byte) error {
	stream.mu.Lock()
	defer stream.mu.Unlock()
	if stream.closed {
		return errClosed
	}
	if _, err := stream.writer.Write(append(append([]byte("data: "), data...), '\n', '\n')); err != nil {
		return err
	}
	if stream.flusher != nil {
		stream.flusher.Flush()
	}
	return nil
}

func (stream *StreamWriter) WriteJSON(value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return stream.WriteMessage(TextMessage, data)
}

func (stream *StreamWriter) SetWriteDeadline(deadline time.Time) error {
	return http.NewResponseController(stream.writer).SetWriteDeadline(deadline)
}

func (stream *StreamWriter) Close() error {
	stream.mu.Lock()
	defer stream.mu.Unlock()
	stream.closed = true
	return nil
}
