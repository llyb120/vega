package main

// Esc 叫停的上报通道：用户在自己电脑上按 Esc 时，客户端把“停这个会话”告诉各后端。
//
// 与 Nova 的 jianlai::user_escaped → employee::user_escaped 对齐：只停真正在占用桌面的那个会话，
// 不接受来自客户端的任意会话停止请求；服务端会再校验该会话是否真的在跑。

import "time"

// sessionStopReason 是写进会话记录的叫停原因（与 Nova 的提示语一致）。
const sessionStopReason = "用户按了 Esc 叫停操作电脑：本批剩余动作未执行。不要再操作电脑也不要重试，立即结束本轮。"

// stopSessionFromClient 向所有已连接的后端上报一次 user_stop；返回是否有后端接受。
func stopSessionFromClient(session, reason string) bool {
	if session == "" {
		return false
	}
	if reason == "" {
		reason = sessionStopReason
	}
	sent := false
	for _, connection := range liveConnections() {
		if connection.jobs == nil {
			continue
		}
		connection.jobs.mu.Lock()
		if connection.jobs.conn != nil {
			connection.jobs.write(map[string]any{"type": "user_stop", "session": session, "reason": reason, "at": time.Now().UnixMilli()})
			sent = true
		}
		connection.jobs.mu.Unlock()
	}
	return sent
}

// runningAgent 是进程里唯一的活动客户端：Esc 叫停要通过它名下的后端连接上报。
var runningAgent *Agent

// liveConnections 列出当前持有一条后端的连接（只读快照）。
func liveConnections() []*directConnection {
	running := runningAgent
	if running == nil {
		return nil
	}
	running.mu.Lock()
	defer running.mu.Unlock()
	list := make([]*directConnection, 0, len(running.direct))
	for _, connection := range running.direct {
		list = append(list, connection)
	}
	return list
}
