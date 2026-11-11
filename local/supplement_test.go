package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSupplementSyncPreservesJobsAndDefersUpdates(t *testing.T) {
	messages := make(chan map[string]string, 1)
	backend := httptest.NewServer(newChannelServer(func(peer *channelPeer, r *http.Request) {
		message, ok := peer.poll()
		if !ok {
			return
		}
		var value map[string]string
		if json.Unmarshal(message.raw, &value) == nil {
			messages <- value
		}
	}))
	defer backend.Close()
	conn, _, err := Dial("http"+strings.TrimPrefix(backend.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	runner := newJobRunner(context.Background(), true)
	runner.conn = conn
	runner.tasks["existing-job"] = &localJob{}
	agent := &Agent{configPath: filepath.Join(t.TempDir(), "trusted-sites.json"), direct: map[string]*directConnection{"backend": {jobs: runner}}}
	if err = agent.editSupplement(func(string) (string, bool, error) {
		undo, ready := agent.prepareUpdate(context.Background(), []*directConnection{{jobs: runner}})
		undo()
		if ready {
			t.Fatal("an open editor must prevent automatic installation")
		}
		return "项目目录：D:\\code\\project", true, nil
	}); err != nil {
		t.Fatal(err)
	}
	message := receive(t, messages)
	if len(message) != 2 || message["type"] != "ping" || message["supplement"] != agent.config.Supplement || runner.supplement != agent.config.Supplement {
		t.Fatalf("hint update must send only context, not other client config: %v", message)
	}
	if len(runner.tasks) != 1 || agent.editing {
		t.Fatal("saving a hint interrupted an existing job or left the editor busy")
	}
}

func TestSupplementSaveCancelClearAndFailure(t *testing.T) {
	path := filepath.Join(t.TempDir(), "trusted-sites.json")
	agent := &Agent{configPath: path, config: Config{ClientID: strings.Repeat("a", 32), Supplement: "旧的项目说明", TrustedOrigins: []string{"https://example.test"}}}
	if err := agent.saveConfig(agent.config); err != nil {
		t.Fatal(err)
	}
	value := "项目目录：D:\\code\\演示项目\r\n请先阅读项目约定。"
	if err := agent.editSupplement(func(current string) (string, bool, error) {
		if current != "旧的项目说明" || !agent.editing {
			t.Fatal("dialog must receive the saved content and reserve editing")
		}
		return value, true, nil
	}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	var saved Config
	if err != nil || json.Unmarshal(data, &saved) != nil || saved.Supplement != value || len(saved.TrustedOrigins) != 1 {
		t.Fatalf("supplement was not persisted without losing existing config: %v", err)
	}
	for _, edit := range []func(string) (string, bool, error){
		func(string) (string, bool, error) { return "discarded", false, nil },
		func(string) (string, bool, error) { return "", false, fmt.Errorf("dialog unavailable") },
		func(string) (string, bool, error) { return strings.Repeat("中", 3000), true, nil },
		func(string) (string, bool, error) { return "bad\x00text", true, nil },
	} {
		_ = agent.editSupplement(edit)
		after, readErr := os.ReadFile(path)
		if readErr != nil || string(after) != string(data) || agent.config.Supplement != value || agent.editing {
			t.Fatal("cancel, invalid input or a dialog error changed saved content")
		}
	}
	agent.configPath = t.TempDir() // Replacing a directory must fail without changing the current config.
	if err = agent.editSupplement(func(string) (string, bool, error) { return "not saved", true, nil }); err == nil || agent.config.Supplement != value || agent.editing {
		t.Fatal("failed save replaced the current content")
	}
	agent.configPath = path
	if err = agent.editSupplement(func(string) (string, bool, error) { return "", true, nil }); err != nil || agent.config.Supplement != "" {
		t.Fatal("saving an empty input must clear the supplement")
	}
	for _, busy := range []string{"editing", "updating"} {
		agent.editing, agent.updating = busy == "editing", busy == "updating"
		if err = agent.editSupplement(func(string) (string, bool, error) {
			t.Fatal("must not open another dialog while editing or updating")
			return "", false, nil
		}); err == nil {
			t.Fatal("busy editor was not rejected")
		}
	}
}
