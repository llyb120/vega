package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidOrigin(t *testing.T) {
	ok := []string{"http://127.0.0.1:8080", "https://vega.example.com"}
	bad := []string{"", "ftp://example.com", "http://example.com/app", "http://example.com/?x=1", "http://user:pass@example.com"}
	for _, origin := range ok {
		if !validOrigin(origin) {
			t.Fatalf("expected valid origin %q", origin)
		}
	}
	for _, origin := range bad {
		if validOrigin(origin) {
			t.Fatalf("expected invalid origin %q", origin)
		}
	}
}

func TestReadInstancePin(t *testing.T) {
	dir := t.TempDir()
	if _, err := readInstancePin(dir); err == nil || !strings.Contains(err.Error(), "instance.json") {
		t.Fatalf("missing pin: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, instanceFileName), []byte(`{"origin":"https://vega.example"}`), 0600); err != nil {
		t.Fatal(err)
	}
	pin, err := readInstancePin(dir)
	if err != nil {
		t.Fatal(err)
	}
	if pin.Origin != "https://vega.example" {
		t.Fatalf("origin = %q", pin.Origin)
	}
	if err := os.WriteFile(filepath.Join(dir, instanceFileName), []byte(`{"origin":"http://example.com/path"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readInstancePin(dir); err == nil || !strings.Contains(err.Error(), "无效") {
		t.Fatalf("invalid origin: %v", err)
	}
}

func TestResolvePinFromEnv(t *testing.T) {
	t.Setenv("VEGA_ORIGIN", "https://vega.example")
	pin, err := resolvePin()
	if err != nil {
		t.Fatal(err)
	}
	if pin.Origin != "https://vega.example" {
		t.Fatalf("origin = %q", pin.Origin)
	}
	t.Setenv("VEGA_ORIGIN", "not-a-url")
	if _, err := resolvePin(); err == nil || !strings.Contains(err.Error(), "VEGA_ORIGIN") {
		t.Fatalf("invalid env: %v", err)
	}
}

func TestResolvePinFromWorkingDirectory(t *testing.T) {
	t.Setenv("VEGA_ORIGIN", "")
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, instanceFileName), []byte(`{"origin":"http://127.0.0.1:8080"}`), 0600); err != nil {
		t.Fatal(err)
	}
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(cwd) })
	pin, err := resolvePin()
	if err != nil {
		t.Fatal(err)
	}
	if pin.Origin != "http://127.0.0.1:8080" {
		t.Fatalf("origin = %q", pin.Origin)
	}
}

func TestBindingsOriginsIncludesPinnedSite(t *testing.T) {
	got := bindingsOrigins("https://vega.example")
	if !strings.HasPrefix(got, "https://vega.example,") {
		t.Fatalf("bindings = %q", got)
	}
}
