package main

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

//go:embed VERSION
var versionText string
var clientVersion = strings.TrimSpace(versionText)

const updateIdle = 60 * time.Second
const maxUpdateSize = 128 << 20

var releaseVersion = regexp.MustCompile(`^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$`)

type clientAsset struct {
	File   string `json:"file"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}
type clientManifest struct {
	Version string                 `json:"version"`
	Assets  map[string]clientAsset `json:"assets"`
}
type stagedUpdate struct {
	version, path, origin string
}

func newerVersion(next, current string) bool {
	if !releaseVersion.MatchString(next) || !releaseVersion.MatchString(current) {
		return false
	}
	a, b := strings.Split(next, "."), strings.Split(current, ".")
	for i := range a {
		x, _ := strconv.Atoi(a[i])
		y, _ := strconv.Atoi(b[i])
		if x != y {
			return x > y
		}
	}
	return false
}
func secureUpdateOrigin(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil || u.User != nil || u.Host == "" || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	ip := net.ParseIP(u.Hostname())
	return u.Scheme == "https" || (u.Scheme == "http" && (u.Hostname() == "localhost" || (ip != nil && ip.IsLoopback())))
}
func clientFilename() string {
	name := "vega-local-" + runtime.GOOS + "-" + runtime.GOARCH
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return name
}
func executablePath() (string, error) {
	path, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(path)
}
func downloadUpdate(ctx context.Context, origin, current, target string) (*stagedUpdate, error) {
	if !secureUpdateOrigin(origin) {
		return nil, fmt.Errorf("automatic updates require HTTPS (or loopback HTTP)")
	}
	client := &http.Client{Timeout: 5 * time.Minute, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 || req.URL.Scheme+"://"+req.URL.Host != origin {
			return fmt.Errorf("cross-origin update redirect refused")
		}
		return nil
	}}
	get := func(path string) (*http.Response, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, origin+"/clients/"+path, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Cache-Control", "no-cache")
		response, err := client.Do(req)
		if err != nil {
			return nil, err
		}
		if response.StatusCode != http.StatusOK {
			response.Body.Close()
			return nil, fmt.Errorf("update HTTP status %d", response.StatusCode)
		}
		return response, nil
	}
	response, err := get("manifest.json")
	if err != nil {
		return nil, err
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, (64<<10)+1))
	response.Body.Close()
	if err != nil || len(data) > 64<<10 {
		return nil, fmt.Errorf("invalid update manifest size")
	}
	var manifest clientManifest
	if err := json.Unmarshal(data, &manifest); err != nil || !releaseVersion.MatchString(manifest.Version) {
		return nil, fmt.Errorf("invalid update manifest")
	}
	if !newerVersion(manifest.Version, current) {
		return nil, nil
	}
	asset, ok := manifest.Assets[runtime.GOOS+"-"+runtime.GOARCH]
	digest, err := hex.DecodeString(asset.SHA256)
	if !ok || asset.File != clientFilename() || err != nil || len(digest) != sha256.Size || asset.Size <= 0 || asset.Size > maxUpdateSize {
		return nil, fmt.Errorf("invalid update asset")
	}
	response, err = get(asset.File)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	file, err := os.CreateTemp(filepath.Dir(target), ".vega-update-*.exe")
	if err != nil {
		return nil, err // Read-only installations keep running their current version.
	}
	keep := false
	defer func() {
		file.Close()
		if !keep {
			os.Remove(file.Name())
		}
	}()
	hash := sha256.New()
	n, err := io.Copy(io.MultiWriter(file, hash), io.LimitReader(response.Body, asset.Size+1))
	if err != nil || n != asset.Size || !strings.EqualFold(hex.EncodeToString(hash.Sum(nil)), asset.SHA256) {
		return nil, fmt.Errorf("update size or SHA-256 mismatch")
	}
	if err := file.Chmod(0755); err != nil {
		return nil, err
	}
	if err := file.Sync(); err != nil {
		return nil, err
	}
	if err := file.Close(); err != nil {
		return nil, err
	}
	keep = true
	return &stagedUpdate{version: manifest.Version, path: file.Name(), origin: origin}, nil
}

func (a *Agent) updateConnections() []*directConnection {
	a.mu.Lock()
	defer a.mu.Unlock()
	connections := make([]*directConnection, 0, len(a.direct))
	for _, connection := range a.direct {
		connections = append(connections, connection)
	}
	return connections
}
func idleConnections(connections []*directConnection, now time.Time) bool {
	if len(connections) == 0 {
		return false
	}
	for _, connection := range connections {
		runner := connection.jobs
		runner.mu.Lock()
		idle := runner.conn != nil && !runner.sessionBusy && runner.running == 0 && len(runner.tasks) == 0 && now.Sub(runner.lastActivity) >= updateIdle
		runner.mu.Unlock()
		if !idle {
			return false
		}
	}
	localChrome.mu.Lock()
	defer localChrome.mu.Unlock()
	return localChrome.connection == nil && len(localChrome.pending) == 0
}

// Every backend must stop dispatching before any process exits; a raced job vetoes the update.
func (a *Agent) prepareUpdate(ctx context.Context, connections []*directConnection) (func(), bool) {
	var sockets []*Conn
	undo := func() {
		for _, socket := range sockets {
			socket.Close() // Reconnect the same instance to release any server-side update reservation.
		}
		a.mu.Lock()
		a.updating = false
		a.mu.Unlock()
	}
	a.mu.Lock()
	editing := a.editing
	a.mu.Unlock()
	if editing {
		return undo, false
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	for _, connection := range connections {
		runner := connection.jobs
		runner.mu.Lock()
		if runner.conn == nil || runner.sessionBusy || runner.running != 0 || len(runner.tasks) != 0 || runner.updateReady != nil {
			runner.mu.Unlock()
			return undo, false
		}
		response := make(chan bool, 1)
		runner.updateReady = response
		sockets = append(sockets, runner.conn)
		runner.write(map[string]string{"type": "update_prepare"})
		runner.mu.Unlock()
		select {
		case ok := <-response:
			if !ok {
				sockets = sockets[:len(sockets)-1] // A busy backend never reserved this socket; leave its session connected.
				return undo, false
			}
		case <-ctx.Done():
			return undo, false
		}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.editing || ctx.Err() != nil || len(a.direct) != len(connections) || len(connections) == 0 {
		return undo, false
	}
	for i, connection := range connections {
		found := false
		for _, current := range a.direct {
			found = found || (current == connection && current.status.Code == "connected" && current.autoUpdate)
		}
		runner := connection.jobs
		runner.mu.Lock()
		defer runner.mu.Unlock()
		if !found || runner.conn != sockets[i] || runner.sessionBusy || runner.updateReady == nil || runner.running != 0 || len(runner.tasks) != 0 {
			return undo, false
		}
	}
	a.updating = true
	return undo, true
}
func (a *Agent) autoUpdate(ctx context.Context, quit func()) {
	currentVersion := clientVersion
	if failed := os.Getenv("VEGA_LOCAL_FAILED_UPDATE"); newerVersion(failed, currentVersion) {
		currentVersion = failed // Do not restart-loop on a release that just failed its startup check.
	}
	_ = os.Unsetenv("VEGA_LOCAL_FAILED_UPDATE")
	target, err := executablePath()
	if err != nil {
		return
	}
	nextCheck := map[string]time.Time{}
	var pending *stagedUpdate
	defer func() {
		if pending != nil {
			os.Remove(pending.path)
		}
	}()
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	nextApply := time.Time{}
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			connections := a.updateConnections()
			trusted := false
			for _, connection := range connections {
				trusted = trusted || (pending != nil && pending.origin == connection.origin)
			}
			if pending != nil && len(connections) > 0 && !trusted {
				os.Remove(pending.path)
				pending = nil
			}
			for _, connection := range connections {
				a.mu.Lock()
				canUpdate := connection.status.Code == "connected" && connection.autoUpdate
				a.mu.Unlock()
				if !canUpdate {
					continue
				}
				origin := connection.origin
				if now.Before(nextCheck[origin]) || !secureUpdateOrigin(origin) {
					continue
				}
				current := currentVersion
				if pending != nil {
					current = pending.version
				}
				update, err := downloadUpdate(ctx, origin, current, target)
				nextCheck[origin] = time.Now().Add(time.Hour)
				if err != nil {
					nextCheck[origin] = time.Now().Add(5 * time.Minute)
					continue
				}
				if update != nil {
					if pending != nil {
						os.Remove(pending.path)
					}
					pending = update
				}
			}
			connections = a.updateConnections()
			a.mu.Lock()
			ready := !a.editing
			trusted = false
			for _, connection := range connections {
				ready = ready && connection.status.Code == "connected" && connection.autoUpdate
			}
			for _, origin := range a.config.TrustedOrigins {
				trusted = trusted || (pending != nil && pending.origin == origin)
			}
			a.mu.Unlock()
			if pending == nil || !ready || !trusted || time.Now().Before(nextApply) || !idleConnections(connections, time.Now()) {
				continue
			}
			undo, ok := a.prepareUpdate(ctx, connections)
			if !ok {
				undo()
				continue
			}
			instances := make(map[string]string, len(connections))
			a.mu.Lock()
			for key, connection := range a.direct {
				instances[key] = connection.instance
			}
			a.mu.Unlock()
			if err := startUpdateHelper(ctx, target, pending, instances); err != nil {
				undo()
				nextApply = time.Now().Add(5 * time.Minute)
				continue
			}
			quit()
			return
		}
	}
}
