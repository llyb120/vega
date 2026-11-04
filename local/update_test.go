package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// Exercise the real handoff in child processes, never the user's installed client or ports.
func TestMain(m *testing.M) {
	if os.Getenv("VEGA_UPDATE_TEST_HELPER") != "1" {
		os.Exit(m.Run())
	}
	if len(os.Args) > 1 && os.Args[1] == "--apply-update" {
		if err := applyUpdate(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		os.Exit(0)
	}
	if os.Getenv("VEGA_LOCAL_UPDATE_READY") != "" {
		path, _ := os.Executable()
		data, _ := os.ReadFile(path)
		if strings.HasSuffix(string(data), "VEGA_TEST_FAIL_START") {
			os.Exit(6)
		}
		if err := notifyUpdateReady(); err != nil {
			os.Exit(2)
		}
		cwd, _ := os.Getwd()
		data, _ = json.Marshal(map[string]any{"pid": os.Getpid(), "cwd": cwd, "resume": os.Getenv("VEGA_LOCAL_RESUME"), "failed": os.Getenv("VEGA_LOCAL_FAILED_UPDATE")})
		if os.WriteFile(os.Getenv("VEGA_UPDATE_TEST_REPORT"), data, 0600) != nil {
			os.Exit(3)
		}
		time.Sleep(time.Minute)
		os.Exit(0)
	}
	if len(os.Args) == 4 && os.Args[1] == "--test-update-parent" {
		update := &stagedUpdate{path: os.Args[3], version: clientVersion}
		instances := map[string]string{"https://example.test\x00alice": strings.Repeat("a", 32)}
		if err := startUpdateHelper(context.Background(), os.Args[2], update, instances); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(4)
		}
		os.Exit(0)
	}
	os.Exit(5)
}

func TestClientVersions(t *testing.T) {
	if !releaseVersion.MatchString(clientVersion) {
		t.Fatal("invalid embedded VERSION", clientVersion)
	}
	for _, test := range []struct {
		next, current string
		want          bool
	}{
		{"0.3.1", "0.3.0", true}, {"0.10.0", "0.9.99", true}, {"1.0.0", "0.99.99", true},
		{"0.3.0", "0.3.0", false}, {"0.2.99", "0.3.0", false}, {"0.03.1", "0.3.0", false},
		{"0.3.1-beta", "0.3.0", false}, {"99999999999.0.0", "0.3.0", false}, {"1.0.0", "dev", false},
	} {
		if newerVersion(test.next, test.current) != test.want {
			t.Errorf("version comparison %s > %s", test.next, test.current)
		}
	}
	for origin, want := range map[string]bool{
		"https://example.test": true, "http://127.0.0.1:8080": true, "http://[::1]:8080": true,
		"http://localhost:8080": true, "http://example.test": false, "http://127.0.0.1.evil.test": false,
		"https://user:pass@example.test": false, "https://example.test/path": false, "file:///tmp": false,
	} {
		if secureUpdateOrigin(origin) != want {
			t.Errorf("update origin %s", origin)
		}
	}
}
func TestUpdateDownloadValidation(t *testing.T) {
	for _, scenario := range []string{"valid", "same", "older", "bad-version", "missing-platform", "path-traversal", "bad-hash", "short", "long", "oversized", "empty", "redirect", "bad-json", "large-manifest", "not-found"} {
		t.Run(scenario, func(t *testing.T) {
			body := []byte("new native client")
			hash := sha256.Sum256(body)
			asset := clientAsset{File: clientFilename(), Size: int64(len(body)), SHA256: hex.EncodeToString(hash[:])}
			manifest := clientManifest{Version: "0.3.1", Assets: map[string]clientAsset{runtime.GOOS + "-" + runtime.GOARCH: asset}}
			switch scenario {
			case "same":
				manifest.Version = "0.3.0"
			case "older":
				manifest.Version = "0.2.0"
			case "bad-version":
				manifest.Version = "0.03.1"
			case "missing-platform":
				manifest.Assets = nil
			case "path-traversal":
				asset.File = "../outside.exe"
			case "bad-hash":
				asset.SHA256 = strings.Repeat("0", 64)
			case "short":
				asset.Size++
			case "long":
				asset.Size--
			case "oversized":
				asset.Size = maxUpdateSize + 1
			case "empty":
				asset.Size = 0
			}
			if scenario != "missing-platform" {
				manifest.Assets[runtime.GOOS+"-"+runtime.GOARCH] = asset
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "" {
					t.Error("device token must not be used for static downloads")
				}
				if r.URL.Path == "/clients/manifest.json" {
					switch scenario {
					case "bad-json":
						fmt.Fprint(w, "{")
						return
					case "large-manifest":
						fmt.Fprint(w, strings.Repeat(" ", (64<<10)+1))
						return
					case "not-found":
						http.NotFound(w, r)
						return
					}
					_ = json.NewEncoder(w).Encode(manifest)
					return
				}
				if scenario == "redirect" {
					http.Redirect(w, r, "http://example.test/payload", http.StatusFound)
					return
				}
				_, _ = w.Write(body)
			}))
			defer server.Close()
			dir := t.TempDir()
			update, err := downloadUpdate(context.Background(), server.URL, "0.3.0", filepath.Join(dir, "client.exe"))
			switch scenario {
			case "valid":
				if err != nil || update == nil {
					t.Fatalf("download: %v, %v", update, err)
				}
				data, err := os.ReadFile(update.path)
				if err != nil || string(data) != string(body) || update.version != "0.3.1" {
					t.Fatal("incorrect staged release")
				}
			case "same", "older":
				if err != nil || update != nil {
					t.Fatal("must never reinstall or downgrade", err)
				}
			default:
				if err == nil || update != nil {
					t.Fatal("invalid release was staged")
				}
			}
			files, _ := os.ReadDir(dir)
			if scenario != "valid" && len(files) != 0 {
				t.Fatal("failed download left partial executables")
			}
		})
	}
}
func TestUpdateIdleWaitsForJobsResultsQuietPeriodAndBrowserLease(t *testing.T) {
	saved := localChrome
	localChrome = newBrowserBridge()
	defer func() { localChrome = saved }()
	now := time.Now()
	runner := newJobRunner(context.Background(), true)
	runner.conn = &websocket.Conn{}
	runner.lastActivity = now.Add(-2 * updateIdle)
	connections := []*directConnection{{jobs: runner}}
	if idleConnections(nil, now) || !idleConnections(connections, now) {
		t.Fatal("idle baseline")
	}
	runner.sessionBusy = true
	if idleConnections(connections, now) {
		t.Fatal("a running session is not idle during model thinking or between tool calls")
	}
	runner.sessionBusy = false
	runner.tasks["pending"] = &localJob{result: []byte(`{"done":true}`)}
	if idleConnections(connections, now) {
		t.Fatal("unacknowledged result is not idle")
	}
	delete(runner.tasks, "pending")
	runner.running = 1
	if idleConnections(connections, now) {
		t.Fatal("cancelled but still exiting job is not idle")
	}
	runner.running = 0
	runner.lastActivity = now
	if idleConnections(connections, now) {
		t.Fatal("must wait for the quiet period")
	}
	runner.lastActivity = now.Add(-2 * updateIdle)
	localChrome.connection = context.Background()
	if idleConnections(connections, now) {
		t.Fatal("browser lease must prevent restart between commands")
	}
	localChrome.connection = nil
	runner.conn = nil
	if idleConnections(connections, now) {
		t.Fatal("disconnected backend is not idle")
	}
}
func TestClientReplacementAndRollback(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(strconv.FormatBool(fail), func(t *testing.T) {
			dir := t.TempDir()
			target, staged := filepath.Join(dir, "client.exe"), filepath.Join(dir, "next.exe")
			if err := os.WriteFile(target, []byte("old"), 0755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(staged, []byte("new"), 0755); err != nil {
				t.Fatal(err)
			}
			err := replaceClient(target, staged, func() error {
				data, _ := os.ReadFile(target)
				if string(data) != "new" {
					t.Fatal("startup must use new executable")
				}
				if fail {
					return fmt.Errorf("startup failed")
				}
				return nil
			})
			if (err != nil) != fail {
				t.Fatal("incorrect replacement outcome", err)
			}
			data, _ := os.ReadFile(target)
			want := "new"
			if fail {
				want = "old"
			}
			if string(data) != want {
				t.Fatal("incorrect installed binary", string(data))
			}
			files, _ := os.ReadDir(dir)
			if len(files) != 2 {
				t.Fatal("temporary backup was not cleaned up")
			}
		})
	}
}
func TestUpdatePrepareRequiresEveryBackend(t *testing.T) {
	for _, ready := range []bool{true, false} {
		t.Run(strconv.FormatBool(ready), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
				if err != nil {
					return
				}
				defer conn.Close()
				var request job
				if conn.ReadJSON(&request) != nil || request.Type != "update_prepare" {
					return
				}
				response := "update_ready"
				if !ready && r.URL.Path == "/last" {
					response = "update_busy"
				}
				_ = conn.WriteJSON(map[string]string{"type": response})
				if !ready && r.URL.Path == "/last" {
					for conn.ReadJSON(&request) == nil {
						_ = conn.WriteJSON(map[string]any{"type": "pong", "busy": false})
					}
					return
				}
				_ = conn.ReadJSON(&request)
			}))
			defer server.Close()
			agent := &Agent{direct: map[string]*directConnection{}}
			var connections []*directConnection
			var finishes []chan struct{}
			for _, path := range []string{"/first", "/last"} {
				conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+path, nil)
				if err != nil {
					t.Fatal(err)
				}
				defer conn.Close()
				runner := newJobRunner(context.Background(), true)
				finished := make(chan struct{})
				go func() { runner.run(conn, nil, nil); close(finished) }()
				deadline := time.Now().Add(time.Second)
				for {
					runner.mu.Lock()
					started := runner.conn != nil
					runner.mu.Unlock()
					if started {
						break
					}
					if time.Now().After(deadline) {
						t.Fatal("job runner did not start")
					}
					time.Sleep(time.Millisecond)
				}
				connection := &directConnection{jobs: runner, autoUpdate: true, status: connectionStatus{Code: "connected"}}
				agent.direct[path] = connection
				connections = append(connections, connection)
				finishes = append(finishes, finished)
			}
			undo, ok := agent.prepareUpdate(context.Background(), connections)
			if ok != ready || agent.updating != ready {
				t.Fatal("incorrect backend drain result")
			}
			undo()
			if agent.updating {
				t.Fatal("aborted update remained reserved")
			}
			for i, connection := range connections {
				if !ready && i == len(connections)-1 {
					runner := connection.jobs
					runner.mu.Lock()
					socket, waiting := runner.conn, runner.updateReady
					runner.write(map[string]string{"type": "ping"})
					runner.mu.Unlock()
					if socket == nil || waiting != nil {
						t.Fatal("busy rejection disconnected the running session or retained an update request")
					}
					deadline := time.Now().Add(time.Second)
					for {
						runner.mu.Lock()
						busy := runner.sessionBusy
						runner.mu.Unlock()
						if !busy {
							break
						}
						if time.Now().After(deadline) {
							t.Fatal("idle heartbeat did not clear session activity")
						}
						time.Sleep(time.Millisecond)
					}
					socket.Close()
				}
				receive(t, finishes[i])
				connection.jobs.close()
			}
		})
	}
}

func TestConnectionInstancesResumeOnlyValidHandoff(t *testing.T) {
	for _, instance := range []string{strings.Repeat("a", 32), strings.Repeat("z", 32), "invalid"} {
		t.Run(instance, func(t *testing.T) {
			clientID := strings.Repeat("c", 32)
			accepted := make(chan string, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
				if err != nil {
					return
				}
				defer conn.Close()
				var hello struct{ Instance string }
				if conn.ReadJSON(&hello) != nil {
					return
				}
				_ = conn.WriteJSON(map[string]any{"type": "ready", "clientId": clientID, "userId": "alice", "resume": true, "autoUpdate": true, "sessionIdle": instance == strings.Repeat("a", 32), "busy": true})
				accepted <- hello.Instance
				var value any
				_ = conn.ReadJSON(&value)
			}))
			defer server.Close()
			state, _ := json.Marshal(map[string]string{server.URL + "\x00alice": instance})
			t.Setenv("VEGA_LOCAL_RESUME", string(state))
			token, err := protectToken(strings.Repeat("t", 43))
			if err != nil {
				t.Fatal(err)
			}
			agent := &Agent{config: Config{ClientID: clientID, TrustedOrigins: []string{server.URL}, Servers: []ServerCredential{{Origin: server.URL, UserID: "alice", Token: token}}}, connections: make(map[*websocket.Conn]struct{})}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			agent.startConnections(ctx)
			actual := receive(t, accepted)
			agent.mu.Lock()
			connection := agent.direct[server.URL+"\x00alice"]
			agent.mu.Unlock()
			deadline := time.Now().Add(time.Second)
			for {
				agent.mu.Lock()
				connected, updates := connection.status.Code == "connected", connection.autoUpdate
				agent.mu.Unlock()
				if connected {
					if updates != (instance == strings.Repeat("a", 32)) {
						t.Fatal("updates require server session-idle support")
					}
					connection.jobs.mu.Lock()
					busy := connection.jobs.sessionBusy
					connection.jobs.mu.Unlock()
					if !busy {
						t.Fatal("initial handshake lost active-session state")
					}
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("backend did not become ready")
				}
				time.Sleep(time.Millisecond)
			}
			if instance == strings.Repeat("a", 32) {
				if actual != instance {
					t.Fatal("valid execution instance was not restored")
				}
			} else if actual == instance || len(actual) != 32 {
				t.Fatal("invalid handoff instance was accepted")
			}
			if os.Getenv("VEGA_LOCAL_RESUME") != "" {
				t.Fatal("handoff state leaked to job environments")
			}
		})
	}
}

func TestUpdateHelperRestartsWithWorkingDirectoryAndInstances(t *testing.T) {
	for _, failStartup := range []bool{false, true} {
		t.Run(strconv.FormatBool(failStartup), func(t *testing.T) { testUpdateHelper(t, failStartup) })
	}
}
func testUpdateHelper(t *testing.T, failStartup bool) {
	dir := t.TempDir()
	source, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	target, staged := filepath.Join(dir, "installed client.exe"), filepath.Join(dir, ".vega-update-test.exe")
	for _, path := range []string{target, staged} {
		if err := os.WriteFile(path, data, 0755); err != nil {
			t.Fatal(err)
		}
	}
	if failStartup {
		if err := os.WriteFile(staged, append(data, []byte("VEGA_TEST_FAIL_START")...), 0755); err != nil {
			t.Fatal(err)
		}
	}
	report := filepath.Join(dir, "report.json")
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, target, "--test-update-parent", target, staged)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "VEGA_UPDATE_TEST_HELPER=1", "VEGA_UPDATE_TEST_REPORT="+report)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("parent handoff: %v", err)
	}
	var result struct {
		PID                 int
		Cwd, Resume, Failed string
	}
	deadline := time.Now().Add(25 * time.Second)
	for {
		data, err := os.ReadFile(report)
		if err == nil && json.Unmarshal(data, &result) == nil && result.PID != 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("updated client never became ready")
		}
		time.Sleep(20 * time.Millisecond)
	}
	process, err := os.FindProcess(result.PID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { process.Kill(); process.Wait() }()
	if !strings.EqualFold(filepath.Clean(result.Cwd), filepath.Clean(dir)) {
		t.Fatal("working directory changed", result.Cwd)
	}
	wantFailed := ""
	if failStartup {
		wantFailed = clientVersion
	}
	if result.Failed != wantFailed {
		t.Fatal("failed release was not suppressed on rollback", result.Failed)
	}
	installed, err := os.ReadFile(target)
	if err != nil || sha256.Sum256(installed) != sha256.Sum256(data) {
		t.Fatal("installed binary was not restored correctly", err)
	}
	var instances map[string]string
	if json.Unmarshal([]byte(result.Resume), &instances) != nil || instances["https://example.test\x00alice"] != strings.Repeat("a", 32) {
		t.Fatal("execution instances were not preserved", result.Resume)
	}
	deadline = time.Now().Add(5 * time.Second)
	for {
		_, err := os.Stat(staged)
		if os.IsNotExist(err) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("updater executable was not cleaned up")
		}
		time.Sleep(20 * time.Millisecond)
	}
}
