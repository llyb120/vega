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
	if err := os.WriteFile(path, []byte(`{"origin":"https://vega.example/path"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readInstancePin(dir); err == nil {
		t.Fatal("origin with a path must be rejected")
	}
	if err := os.WriteFile(path, []byte(`{"origin":"https://vega.example","downloadedAt":1}`), 0600); err != nil {
		t.Fatal(err)
	}
	pin, err := readInstancePin(dir)
	if err != nil || pin.Origin != "https://vega.example" || pin.DownloadedAt != 1 {
		t.Fatalf("valid package site info rejected: %+v %v", pin, err)
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
}
