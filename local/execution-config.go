package main

// RuntimeNode 是账户下的一个浏览器/执行节点（云端或已授权/已连接的客户端）。
type RuntimeNode struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Kind     string `json:"kind"`
	Online   bool   `json:"online,omitempty"`
	Platform string `json:"platform,omitempty"`
	Cwd      string `json:"cwd,omitempty"`
}

// RuntimeView 是服务端下发的账户节点视图（云端 + 各客户端）。
type RuntimeView struct {
	Nodes []RuntimeNode `json:"nodes"`
	Error string        `json:"error,omitempty"`
}

func (a *Agent) applyRuntime(view RuntimeView) {
	a.mu.Lock()
	defer a.mu.Unlock()
	cp := view
	if cp.Nodes == nil {
		cp.Nodes = []RuntimeNode{}
	}
	a.runtime = &cp
}
