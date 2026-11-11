package main

import (
	"fmt"
	"regexp"
)

var masterIDPattern = regexp.MustCompile(`^[a-f0-9-]{32,36}$`)

// RuntimeNode 是账户下可选的 Master 节点（云端或已授权/已连接的客户端）。
type RuntimeNode struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Kind     string `json:"kind"`
	Online   bool   `json:"online,omitempty"`
	Platform string `json:"platform,omitempty"`
	Cwd      string `json:"cwd,omitempty"`
}

// EmployeeMasterView 是服务端确认的某头牛马的两套 Master。
type EmployeeMasterView struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	FsMaster      string `json:"fsMaster"`
	BrowserMaster string `json:"browserMaster"`
}

// EmployeeMasterPref 是客户端本地记住的某头牛马上次选择，仅供离线展示。
type EmployeeMasterPref struct {
	EmployeeID    string `json:"employeeId"`
	Name          string `json:"name,omitempty"`
	FsMaster      string `json:"fsMaster,omitempty"`
	BrowserMaster string `json:"browserMaster,omitempty"`
}

// RuntimeView 是服务端确认的按牛马主从视图。
type RuntimeView struct {
	Nodes     []RuntimeNode        `json:"nodes"`
	Employees []EmployeeMasterView `json:"employees"`
	Error     string               `json:"error,omitempty"`
}

func isMasterID(value string) bool {
	return value == "cloud" || masterIDPattern.MatchString(value)
}

// executionPlace 归一化旧的执行位置偏好：client = 本机为文件系统 Master，cloud = 云端为 Master。
func executionPlace(value string) string {
	if value == "cloud" {
		return "cloud"
	}
	return "client"
}

func (a *Agent) rememberedFsMaster() string {
	if isMasterID(a.config.FsMaster) {
		return a.config.FsMaster
	}
	if executionPlace(a.config.Prefer) == "cloud" {
		return "cloud"
	}
	if a.config.ClientID != "" {
		return a.config.ClientID
	}
	return "cloud"
}

func upsertEmployeeMaster(list []EmployeeMasterPref, employeeID, name, kind, master string) []EmployeeMasterPref {
	next := append([]EmployeeMasterPref{}, list...)
	for i := range next {
		if next[i].EmployeeID != employeeID {
			continue
		}
		if kind == "browser" {
			next[i].BrowserMaster = master
		} else {
			next[i].FsMaster = master
		}
		if name != "" {
			next[i].Name = name
		}
		return next
	}
	item := EmployeeMasterPref{EmployeeID: employeeID, Name: name}
	if kind == "browser" {
		item.BrowserMaster = master
	} else {
		item.FsMaster = master
	}
	return append(next, item)
}

func (a *Agent) rememberedEmployeeMaster(employeeID, kind string) string {
	for _, item := range a.config.EmployeeMasters {
		if item.EmployeeID != employeeID {
			continue
		}
		if kind == "browser" && isMasterID(item.BrowserMaster) {
			return item.BrowserMaster
		}
		if kind != "browser" && isMasterID(item.FsMaster) {
			return item.FsMaster
		}
	}
	if kind == "browser" {
		return a.rememberedBrowserMaster()
	}
	return a.rememberedFsMaster()
}

func (a *Agent) confirmedEmployeeMaster(employeeID, kind string) string {
	if a.runtime != nil {
		for _, item := range a.runtime.Employees {
			if item.ID != employeeID {
				continue
			}
			if kind == "browser" && isMasterID(item.BrowserMaster) {
				return item.BrowserMaster
			}
			if kind != "browser" && isMasterID(item.FsMaster) {
				return item.FsMaster
			}
		}
	}
	return a.rememberedEmployeeMaster(employeeID, kind)
}

func (a *Agent) applyRuntime(view RuntimeView) {
	a.mu.Lock()
	defer a.mu.Unlock()
	cp := view
	if cp.Nodes == nil {
		cp.Nodes = []RuntimeNode{}
	}
	if cp.Employees == nil {
		cp.Employees = []EmployeeMasterView{}
	}
	a.runtime = &cp
	next := a.config
	prefs := append([]EmployeeMasterPref{}, next.EmployeeMasters...)
	changed := false
	byID := map[string]int{}
	for i, item := range prefs {
		byID[item.EmployeeID] = i
	}
	for _, item := range view.Employees {
		if item.ID == "" || (!isMasterID(item.FsMaster) && !isMasterID(item.BrowserMaster)) {
			continue
		}
		if i, ok := byID[item.ID]; ok {
			if prefs[i].FsMaster != item.FsMaster || prefs[i].BrowserMaster != item.BrowserMaster || (item.Name != "" && prefs[i].Name != item.Name) {
				prefs[i].FsMaster = item.FsMaster
				prefs[i].BrowserMaster = item.BrowserMaster
				if item.Name != "" {
					prefs[i].Name = item.Name
				}
				changed = true
			}
			continue
		}
		prefs = append(prefs, EmployeeMasterPref{EmployeeID: item.ID, Name: item.Name, FsMaster: item.FsMaster, BrowserMaster: item.BrowserMaster})
		byID[item.ID] = len(prefs) - 1
		changed = true
	}
	if changed {
		next.EmployeeMasters = prefs
		if err := a.saveConfig(next); err == nil {
			a.config = next
		}
	}
}

func (a *Agent) runtimeNodes(selfID, selfName string) []RuntimeNode {
	nodes := []RuntimeNode{{ID: "cloud", Name: "云端", Kind: "cloud"}}
	seen := map[string]bool{"cloud": true}
	if selfID != "" {
		nodes = append(nodes, RuntimeNode{ID: selfID, Name: selfName, Kind: "client"})
		seen[selfID] = true
	}
	if a.runtime != nil {
		for _, node := range a.runtime.Nodes {
			if node.ID == "" || seen[node.ID] {
				if node.ID == selfID && node.Name != "" && len(nodes) > 1 {
					nodes[1].Name = node.Name
					nodes[1].Online = node.Online
					nodes[1].Platform = node.Platform
				}
				continue
			}
			seen[node.ID] = true
			nodes = append(nodes, node)
		}
	}
	return nodes
}

// saveEmployeeMaster 记住这头牛马的本次选择并请求服务端把该节点设为对应 Master；只影响这头牛马。
func (a *Agent) saveEmployeeMaster(employeeID, kind, value string) error {
	if employeeID == "" {
		return fmt.Errorf("请选择要配置的牛马")
	}
	if kind != "fs" && kind != "browser" {
		return fmt.Errorf("只能设置文件系统或浏览器 Master")
	}
	a.mu.Lock()
	self := a.config.ClientID
	if value == "client" || value == "self" || (kind == "browser" && value == "local") {
		value = self
	}
	label := "文件系统 Master"
	if kind == "browser" {
		label = "浏览器 Master"
	}
	if !isMasterID(value) {
		a.mu.Unlock()
		return fmt.Errorf("请选择云端或一个已授权的客户端作为%s", label)
	}
	if a.updating {
		a.mu.Unlock()
		return fmt.Errorf("客户端正在更新，请稍后再试")
	}
	next := a.config
	next.SelectedEmployee = employeeID
	next.EmployeeMasters = upsertEmployeeMaster(next.EmployeeMasters, employeeID, "", kind, value)
	if err := a.saveConfig(next); err != nil {
		a.mu.Unlock()
		return fmt.Errorf("%s未保存：%w", label, err)
	}
	a.config = next
	runners := make([]*jobRunner, 0, len(a.direct))
	for _, connection := range a.direct {
		runners = append(runners, connection.jobs)
	}
	a.mu.Unlock()
	for _, runner := range runners {
		runner.mu.Lock()
		runner.write(map[string]any{"type": "set_master", "employeeId": employeeID, "kind": kind, "master": value})
		runner.mu.Unlock()
	}
	return nil
}

func (a *Agent) saveFsMaster(employeeID, value string) error {
	return a.saveEmployeeMaster(employeeID, "fs", value)
}

func (a *Agent) saveBrowserMaster(employeeID, value string) error {
	return a.saveEmployeeMaster(employeeID, "browser", value)
}

// saveExecutionPlace 旧接口已不再按账户改 Master，必须指定牛马。
func (a *Agent) saveExecutionPlace(value string) error {
	if value != "client" && value != "cloud" {
		return fmt.Errorf("执行位置只有「客户端优先」或「服务端优先」")
	}
	return fmt.Errorf("请选择要配置的牛马后再设置文件系统 Master")
}

func (a *Agent) pairingMasters() (employees []EmployeeMasterView, nodes []RuntimeNode) {
	self := a.config.ClientID
	nodes = a.runtimeNodes(self, "本机")
	seen := map[string]bool{}
	if a.runtime != nil {
		for _, item := range a.runtime.Employees {
			if item.ID == "" {
				continue
			}
			if !isMasterID(item.FsMaster) {
				item.FsMaster = "cloud"
			}
			if !isMasterID(item.BrowserMaster) {
				item.BrowserMaster = "cloud"
			}
			employees = append(employees, item)
			seen[item.ID] = true
		}
	}
	for _, pref := range a.config.EmployeeMasters {
		if pref.EmployeeID == "" || seen[pref.EmployeeID] {
			continue
		}
		fs, browser := pref.FsMaster, pref.BrowserMaster
		if !isMasterID(fs) {
			fs = "cloud"
		}
		if !isMasterID(browser) {
			browser = "cloud"
		}
		name := pref.Name
		if name == "" {
			name = pref.EmployeeID
		}
		employees = append(employees, EmployeeMasterView{ID: pref.EmployeeID, Name: name, FsMaster: fs, BrowserMaster: browser})
	}
	return
}
