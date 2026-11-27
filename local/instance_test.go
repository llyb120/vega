package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInstancePinIsRequiredAndValidated(t *testing.T) {
	dir := t.TempDir()
	if _, err := readInstancePin(dir); err == nil || !strings.Contains(err.Error(), "instance.json") {
		t.Fatalf("missing package site info must be reported: %v", err)
	}
	path := filepath.Join(dir, "instance.json")
	if err := os.WriteFile(path, []byte(`{"origin":"https://vega.example/apps/vega/","downloadedAt":1}`), 0600); err != nil {
		t.Fatal(err)
	}
	pin, err := readInstancePin(dir)
	if err != nil || pin.Origin != "https://vega.example/apps/vega" || pin.DownloadedAt != 1 {
		t.Fatalf("valid package site info rejected: %+v %v", pin, err)
	}
}

func TestInstancePinAppBundleFallback(t *testing.T) {
	root := t.TempDir()
	macOSDir := filepath.Join(root, "Vega.app", "Contents", "MacOS")
	resDir := filepath.Join(root, "Vega.app", "Contents", "Resources")
	if err := os.MkdirAll(macOSDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(resDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := readInstancePin(macOSDir); err == nil || !strings.Contains(err.Error(), "instance.json") {
		t.Fatalf("missing instance.json across all bundle paths must fail: %v", err)
	}
	parentPin := filepath.Join(root, "instance.json")
	if err := os.WriteFile(parentPin, []byte(`{"origin":"https://parent.example"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	pin, err := readInstancePin(macOSDir)
	if err != nil || pin.Origin != "https://parent.example" {
		t.Fatalf("parent bundle fallback failed: %+v %v", pin, err)
	}
	resPin := filepath.Join(resDir, "instance.json")
	if err := os.WriteFile(resPin, []byte(`{"origin":"https://resources.example"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	pin, err = readInstancePin(macOSDir)
	if err != nil || pin.Origin != "https://resources.example" {
		t.Fatalf("Contents/Resources fallback must take priority over parent: %+v %v", pin, err)
	}
	directPin := filepath.Join(macOSDir, "instance.json")
	if err := os.WriteFile(directPin, []byte(`{"origin":"https://direct.example"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	pin, err = readInstancePin(macOSDir)
	if err != nil || pin.Origin != "https://direct.example" {
		t.Fatalf("direct exeDir must take highest priority: %+v %v", pin, err)
	}
}

func TestSiteBaseRejectsAmbiguousAddresses(t *testing.T) {
	for _, raw := range []string{
		"https://name:password@vega.example/vega", "https://vega.example/vega?x=1", "https://vega.example/vega?",
		"https://vega.example/vega#", "https://vega.example/vega/../other", "https://vega.example/vega/.",
		"https://vega.example/vega//other", "https://vega.example/vega%2Fother", "https://vega.example/%2e%2e/vega",
		`https://vega.example/vega\other`, "//vega.example/vega", "ftp://vega.example/vega",
	} {
		if _, err := parseSiteBase(raw); err == nil {
			t.Errorf("accepted invalid site base %q", raw)
		}
	}
	if !validSiteBase("https://vega.example") || !validSiteBase("https://vega.example/vega") || validOrigin("https://vega.example/vega") {
		t.Fatal("accept site directories in the install pin, not in the browser Origin header")
	}
}

func TestSiteSlugKeepsSitesApart(t *testing.T) {
	for origin, want := range map[string]string{
		"https://vega.example":         "vega.example",
		"https://vega.example:443":     "vega.example",
		"https://vega.example:8443":    "vega.example_8443",
		"http://127.0.0.1:8080":        "http-127.0.0.1_8080",
		"http://Example.COM:80":        "http-example.com",
		"https://a.b-c_d.example.test": "a.b-c_d.example.test",
	} {
		if got, err := siteSlug(origin); err != nil || got != want {
			t.Fatalf("siteSlug(%q) = %q, %v; want %q", origin, got, err, want)
		}
	}
	a, _ := siteSlug("https://vega.example/vega")
	b, _ := siteSlug("https://vega.example/vega/")
	c, _ := siteSlug("https://vega.example/Vega")
	d, _ := siteSlug("https://vega.example/team/vega")
	if a == "" || a != b || a == "vega.example" || a == c || a == d {
		t.Fatalf("unexpected site data directories: %q %q %q %q", a, b, c, d)
	}
}
