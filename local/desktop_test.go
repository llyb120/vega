package main

// The desktop window's plumbing that does not need a real WebView2: the bundled page whitelist, the copies
// it renders with, the URLs it may open and where it opens first.

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestDesktopPageServesOnlyBundledFiles(t *testing.T) {
	a := &Agent{dataDir: t.TempDir(), configToken: "token"}
	mux := http.NewServeMux()
	a.desktopMount(mux)
	base := a.desktopBase()
	get := func(path string) (int, string) {
		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "http://"+localAddress+path, nil))
		body, _ := io.ReadAll(recorder.Result().Body)
		return recorder.Code, string(body)
	}
	for _, name := range []string{"", "index.html", "style.css", "app.js", "markdown.js", "bot-avatar.js"} {
		code, body := get(base + name)
		if code != http.StatusOK || len(body) == 0 {
			t.Fatalf("%q is not served: %d (%d bytes)", name, code, len(body))
		}
	}
	// Anything outside the list (a traversal, a token-less prefix, a stray file) never returns a page.
	for _, name := range []string{"../desktop.go", "secrets.json", "markdown.js/../../trusted-sites.json"} {
		if code, body := get(base + name); code == http.StatusOK || strings.Contains(body, "package main") {
			t.Fatalf("%q answered %d with %d bytes", name, code, len(body))
		}
	}
	if code, _ := get("/window/wrong-token/"); code == http.StatusOK {
		t.Fatal("a page is reachable without the config token")
	}
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "http://"+localAddress+base, nil))
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST to the page answered %d", recorder.Code)
	}
}

// local/ui/markdown.js and bot-avatar.js are copies made by scripts/local-ui.mjs; a drifting copy would
// quietly render the client differently from the website.
func TestDesktopCopiesMatchTheirSources(t *testing.T) {
	for _, copy := range []struct{ source, bundled, shim string }{
		{"../web/src/markdown.js", "ui/markdown.js", "window.renderMarkdown = renderMarkdown;"},
		{"../web/src/bot-avatar.js", "ui/bot-avatar.js", "window.BotAvatar = "},
	} {
		source, err := os.ReadFile(copy.source)
		if err != nil {
			t.Fatalf("read %s: %v", copy.source, err)
		}
		bundled, err := os.ReadFile(copy.bundled)
		if err != nil {
			t.Fatalf("read %s: %v", copy.bundled, err)
		}
		stripped := regexp.MustCompile(`(?m)^export `).ReplaceAllString(string(source), "")
		header := "/* Copied from " + strings.TrimPrefix(copy.source, "../") + " by scripts/local-ui.mjs — do not edit. */\n"
		text := string(bundled)
		if !strings.HasPrefix(text, header) || !strings.Contains(text, stripped) || !strings.Contains(text, copy.shim) {
			t.Fatalf("%s drifted from %s (run node scripts/local-ui.mjs)", copy.bundled, copy.source)
		}
	}
}

func TestDesktopOpensOnlyTheSiteOrLocalSettings(t *testing.T) {
	origin := "https://vega.example.com"
	allowed := []string{
		origin,
		origin + "/employees/e1/tasks/t1",
		"http://" + localAddress + "/config/token",
	}
	for _, address := range allowed {
		if !desktopAddressAllowed(address, origin) {
			t.Fatalf("%q should open", address)
		}
	}
	for _, address := range []string{
		"https://evil.test/",
		"https://vega.example.com.evil.test/",
		"http://vega.example.com/",
		"javascript:alert(1)",
		"file:///C:/secret.txt",
		"http://" + localAddress + "@evil.test/",
	} {
		if desktopAddressAllowed(address, origin) {
			t.Fatalf("%q must not open", address)
		}
	}
	if desktopAddressAllowed("https://vega.example.com/", "") {
		t.Fatal("an empty origin must deny every site URL")
	}
}

func TestDesktopFrameCentresOnceAndKeepsRememberedBounds(t *testing.T) {
	work := desktopRect{Left: 0, Top: 0, Right: 1920, Bottom: 1040}
	identity := func(value int32) int32 { return value }
	x, y, width, height := desktopFrame(work, nil, identity)
	if width != 1040 || height != 760 {
		t.Fatalf("first open should use the reference size, got %dx%d", width, height)
	}
	if x != 440 || y != 140 {
		t.Fatalf("first open should be centred, got %d,%d", x, y)
	}
	saved := desktopGeometry{X: 100, Y: 60, Width: 1200, Height: 800}
	x, y, width, height = desktopFrame(work, &saved, identity)
	if x != 100 || y != 60 || width != 1200 || height != 800 {
		t.Fatalf("a remembered window inside the work area should be reused, got %d,%d %dx%d", x, y, width, height)
	}
	// Dropped onto a smaller screen (or a disconnected monitor) it is shrunk to the work area and centred.
	small := desktopRect{Left: 0, Top: 0, Right: 1280, Bottom: 720}
	x, y, width, height = desktopFrame(small, &saved, identity)
	if x != 40 || y != 0 || width != 1200 || height != 720 {
		t.Fatalf("an off-screen saved window should be shrunk and re-centred, got %d,%d %dx%d", x, y, width, height)
	}
	// A saved size is kept at another DPI; only the default size is scaled.
	scaled := func(value int32) int32 { return value * 2 }
	x, y, width, height = desktopFrame(work, &saved, scaled)
	if width != 1200 || height != 800 || x != 100 {
		t.Fatalf("a saved size must not be re-scaled, got %d,%d %dx%d", x, y, width, height)
	}
	x, y, width, height = desktopFrame(work, nil, scaled)
	if width != 1920 || height != 1040 {
		t.Fatalf("the default size should follow the DPI and stay inside the work area, got %dx%d", width, height)
	}
}

func TestDesktopGeometrySurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	if _, ok := loadDesktopGeometry(dir); ok {
		t.Fatal("a fresh install has no remembered window")
	}
	saveDesktopGeometry(dir, desktopGeometry{X: 10, Y: 20, Width: 1200, Height: 820})
	saved, ok := loadDesktopGeometry(dir)
	if !ok || saved != (desktopGeometry{X: 10, Y: 20, Width: 1200, Height: 820}) {
		t.Fatalf("remembered window lost: %+v %v", saved, ok)
	}
	// A window smaller than the minimum (or a corrupt file) is ignored instead of opening unusably small.
	saveDesktopGeometry(dir, desktopGeometry{X: 0, Y: 0, Width: 200, Height: 100})
	if saved, _ = loadDesktopGeometry(dir); saved.Width != 1200 {
		t.Fatal("an undersized window overwrote the remembered one")
	}
	if err := os.WriteFile(filepath.Join(dir, "window.json"), []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, ok = loadDesktopGeometry(dir); ok {
		t.Fatal("a corrupt window.json must not be used")
	}
}
