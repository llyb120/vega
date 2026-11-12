package main

import "testing"

func TestNormalizeServerURL(t *testing.T) {
	cases := []struct {
		in, out string
		ok      bool
	}{
		{"http://127.0.0.1:8080", "http://127.0.0.1:8080", true},
		{"https://vega.example.com", "https://vega.example.com", true},
		{"127.0.0.1:8080", "http://127.0.0.1:8080", true},
		{"http://localhost:8080/", "http://localhost:8080", true},
		{"", "", false},
		{"ftp://example.com", "", false},
		{"http://example.com/app", "", false},
		{"http://example.com/?x=1", "", false},
	}
	for _, tc := range cases {
		got, err := NormalizeServerURL(tc.in)
		if tc.ok {
			if err != nil {
				t.Fatalf("%q: unexpected error: %v", tc.in, err)
			}
			if got != tc.out {
				t.Fatalf("%q: got %q, want %q", tc.in, got, tc.out)
			}
		} else if err == nil {
			t.Fatalf("%q: expected error, got %q", tc.in, got)
		}
	}
}

func TestBindingsOriginsIncludesConfigured(t *testing.T) {
	got := bindingsOrigins("https://vega.example.com")
	if !containsOrigin(got, "https://vega.example.com") {
		t.Fatalf("missing configured origin in %q", got)
	}
	if !containsOrigin(got, "http://127.0.0.1:*") {
		t.Fatalf("missing localhost wildcard in %q", got)
	}
}

func containsOrigin(list, want string) bool {
	for _, item := range splitCSV(list) {
		if item == want {
			return true
		}
	}
	return false
}

func splitCSV(list string) []string {
	var out []string
	start := 0
	for i := 0; i <= len(list); i++ {
		if i == len(list) || list[i] == ',' {
			if i > start {
				out = append(out, list[start:i])
			}
			start = i + 1
		}
	}
	return out
}
