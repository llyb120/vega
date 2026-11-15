package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// workSettingsTransport is nil in production. Tests set it to an httptest
// server; other tests skip the call so a fake origin never receives a token.
var workSettingsTransport http.RoundTripper

var (
	errWorkUnpaired = errors.New("还没有配对站点，请先完成配对")
	errWorkSkipped  = errors.New("工作设置要连到已配对的站点")
)

type workSettingsError struct {
	status int
	text   string
}

func (e *workSettingsError) Error() string { return e.text }

type workEmployeeView struct {
	ID, Name, Instruction string
	CanManage             bool
}

type workChoice struct {
	ID, Name string
	Selected bool
}

type workRow struct {
	Key, Model string
	Index      int
	AllowSpawn bool
	Computer   bool
	Choices    []workChoice
}

type workSceneView struct {
	Key, Label, Hint string
	Computer         bool
	Rows             []workRow
}

type workView struct {
	Paired, Admin, Viewer bool
	Error, Note           string
	Employees             []workEmployeeView
	Scenes                []workSceneView
	Global, PerEmployee   int
	HasModels             bool
}

type remoteWork struct {
	Admin     bool `json:"admin"`
	Viewer    bool `json:"viewer"`
	Employees []struct {
		ID          string `json:"id"`
		Name        string `json:"name"`
		Instruction string `json:"instruction"`
		CanManage   bool   `json:"canManage"`
	} `json:"employees"`
	Models []struct {
		ID             string `json:"id"`
		Name           string `json:"name"`
		SupportsImages bool   `json:"supportsImages"`
	} `json:"models"`
	Scenes []struct {
		Key, Label, Hint string
		Computer         bool `json:"computer"`
		Rows             []struct {
			Model      string `json:"model"`
			AllowSpawn bool   `json:"allowSpawn"`
		} `json:"rows"`
	} `json:"scenes"`
	Scheduler struct {
		GlobalSlots      int `json:"globalSlots"`
		PerEmployeeSlots int `json:"perEmployeeSlots"`
	} `json:"scheduler"`
	Employee struct {
		ID          string `json:"id"`
		Name        string `json:"name"`
		Instruction string `json:"instruction"`
	} `json:"employee"`
}

var employeeIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,80}$`)

func (a *Agent) postChat(ctx context.Context, op string, payload any) ([]byte, error) {
	if flag.Lookup("test.v") != nil && workSettingsTransport == nil {
		return nil, errWorkSkipped
	}
	origin, token, ok := a.assistantCredential()
	if !ok {
		return nil, errWorkUnpaired
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, origin+"/api/local-agent/chat/"+op, bytes.NewReader(body))
	if err != nil {
		return nil, &workSettingsError{status: http.StatusBadGateway, text: "无法连接站点"}
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 12 * time.Second, Transport: workSettingsTransport, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	resp, err := client.Do(req)
	if err != nil {
		return nil, &workSettingsError{status: http.StatusBadGateway, text: "暂时连不上站点，其它本机设置仍可保存"}
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return nil, &workSettingsError{status: http.StatusBadGateway, text: "站点返回的设置无法读取"}
	}
	if resp.StatusCode >= 300 {
		return nil, &workSettingsError{status: resp.StatusCode, text: workErrorText(resp.StatusCode, data)}
	}
	return data, nil
}

func workErrorText(status int, body []byte) string {
	var payload map[string]any
	if json.Unmarshal(body, &payload) == nil {
		for _, key := range []string{"statusMessage", "error", "message"} {
			text, _ := payload[key].(string)
			text = strings.TrimSpace(text)
			if text != "" && !strings.Contains(strings.ToLower(text), "bearer") && !strings.Contains(strings.ToLower(text), "token") {
				runes := []rune(text)
				if len(runes) > 180 {
					text = string(runes[:180])
				}
				return text
			}
		}
	}
	if status == http.StatusNotFound || status == http.StatusUnauthorized {
		return "服务端还没有更新到支持这些设置的版本"
	}
	return "设置没有保存（HTTP " + strconv.Itoa(status) + "）"
}

func (a *Agent) loadWorkSettings(ctx context.Context) workView {
	view := workView{Employees: []workEmployeeView{}, Global: 3, PerEmployee: 3}
	if _, _, ok := a.assistantCredential(); !ok {
		view.Note = "配对站点后，可以在这里查看和保存工作原则；场景模型仅管理员可改。"
		return view
	}
	view.Paired = true
	data, err := a.postChat(ctx, "settings", map[string]any{"action": "load"})
	if errors.Is(err, errWorkSkipped) {
		view.Note = "工作原则和场景模型保存在已配对的站点上。"
		return view
	}
	if err != nil {
		view.Error = err.Error()
		return view
	}
	var remote remoteWork
	if json.Unmarshal(data, &remote) != nil {
		view.Error = "站点返回的设置无法读取"
		return view
	}
	return workViewFrom(remote)
}

func workViewFrom(remote remoteWork) workView {
	view := workView{Paired: true, Admin: remote.Admin, Viewer: remote.Viewer, Employees: []workEmployeeView{}, Global: remote.Scheduler.GlobalSlots, PerEmployee: remote.Scheduler.PerEmployeeSlots, HasModels: len(remote.Models) > 0}
	if view.Global == 0 {
		view.Global = 3
	}
	if view.PerEmployee == 0 {
		view.PerEmployee = 3
	}
	for _, employee := range remote.Employees {
		view.Employees = append(view.Employees, workEmployeeView{ID: employee.ID, Name: employee.Name, Instruction: employee.Instruction, CanManage: employee.CanManage})
	}
	for _, scene := range remote.Scenes {
		rows := make([]workRow, 0, len(scene.Rows)+1)
		for index, row := range scene.Rows {
			rows = append(rows, workRow{Key: scene.Key, Index: index, Model: row.Model, AllowSpawn: row.AllowSpawn && !scene.Computer, Computer: scene.Computer, Choices: workChoices(remote, scene.Computer, row.Model)})
		}
		rows = append(rows, workRow{Key: scene.Key, Index: len(rows), Computer: scene.Computer, Choices: workChoices(remote, scene.Computer, "")})
		view.Scenes = append(view.Scenes, workSceneView{Key: scene.Key, Label: scene.Label, Hint: scene.Hint, Computer: scene.Computer, Rows: rows})
	}
	return view
}

func workChoices(remote remoteWork, computer bool, selected string) []workChoice {
	choices := []workChoice{}
	known := false
	for _, model := range remote.Models {
		if computer && !model.SupportsImages && model.ID != selected {
			continue
		}
		if model.ID == selected {
			known = true
		}
		name := model.Name
		if name == "" {
			name = model.ID
		}
		choices = append(choices, workChoice{ID: model.ID, Name: name, Selected: model.ID == selected})
	}
	if selected != "" && !known {
		choices = append([]workChoice{{ID: selected, Name: selected + "（暂不可用）", Selected: true}}, choices...)
	}
	return choices
}

func (a *Agent) saveWorkEmployee(ctx context.Context, id, name, instruction string) error {
	if !employeeIDPattern.MatchString(id) {
		return &workSettingsError{status: http.StatusBadRequest, text: "无效的牛马"}
	}
	_, err := a.postChat(ctx, "settings", map[string]any{"action": "employee", "employeeId": id, "name": name, "instruction": instruction})
	return err
}

func parseWorkspace(form url.Values) (map[string]any, error) {
	keys := form["sceneKey"]
	if len(keys) == 0 {
		return nil, &workSettingsError{status: http.StatusBadRequest, text: "缺少场景"}
	}
	noSpawn := map[string]bool{}
	for _, key := range form["sceneNoSpawn"] {
		noSpawn[key] = true
	}
	scenes := map[string][]any{}
	seenKey := map[string]bool{}
	for _, key := range keys {
		if seenKey[key] || !sceneKeyOK(key) {
			return nil, &workSettingsError{status: http.StatusBadRequest, text: "场景无效"}
		}
		seenKey[key] = true
		var rows []any
		seenModel := map[string]bool{}
		for i := 0; i < 32; i++ {
			model := strings.TrimSpace(form.Get(fmt.Sprintf("scene-%s-%d", key, i)))
			if model == "" {
				continue
			}
			if strings.ContainsAny(model, "\r\n") || len(model) > 300 {
				return nil, &workSettingsError{status: http.StatusBadRequest, text: "模型编号无效"}
			}
			if seenModel[model] {
				continue
			}
			seenModel[model] = true
			if noSpawn[key] || form.Get(fmt.Sprintf("scene-%s-spawn-%d", key, i)) != "1" {
				rows = append(rows, model)
			} else {
				rows = append(rows, map[string]any{"model": model, "allowSpawn": true})
			}
		}
		scenes[key] = rows
	}
	global, err := strconv.Atoi(strings.TrimSpace(form.Get("globalSlots")))
	if err != nil || global < 1 || global > 64 {
		return nil, &workSettingsError{status: http.StatusBadRequest, text: "全站并发必须是 1–64 的整数"}
	}
	perEmployee, err := strconv.Atoi(strings.TrimSpace(form.Get("perEmployeeSlots")))
	if err != nil || perEmployee < 1 || perEmployee > 64 {
		return nil, &workSettingsError{status: http.StatusBadRequest, text: "单牛马并发必须是 1–64 的整数"}
	}
	return map[string]any{"action": "workspace", "scenes": scenes, "scheduler": map[string]any{"globalSlots": global, "perEmployeeSlots": perEmployee}}, nil
}

func sceneKeyOK(key string) bool {
	return key == "lightweight" || key == "coding" || key == "computer"
}

func (a *Agent) saveWorkspace(ctx context.Context, form url.Values) error {
	body, err := parseWorkspace(form)
	if err != nil {
		return err
	}
	_, err = a.postChat(ctx, "settings", body)
	return err
}
