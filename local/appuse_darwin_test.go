//go:build darwin && cgo

package main

import (
	"math"
	"testing"
)

func TestDarwinCoordinateConversion(t *testing.T) {
	// Main 2x Retina display (0,0 1440x900pt -> 2880x1800px),
	// left negative-coordinate 1x monitor (-1920,0 1920x1080pt),
	// right 1x monitor (1440,0 1920x1080pt).
	raw := []darwinDisplay{
		{
			DisplayID: 1,
			CGOriginX: 0, CGOriginY: 0, CGWidth: 1440, CGHeight: 900,
			Scale: 2.0, Surface: appuseSurface{W: 2880, H: 1800},
		},
		{
			DisplayID: 2,
			CGOriginX: -1920, CGOriginY: 0, CGWidth: 1920, CGHeight: 1080,
			Scale: 1.0, Surface: appuseSurface{W: 1920, H: 1080},
		},
		{
			DisplayID: 3,
			CGOriginX: 1440, CGOriginY: 0, CGWidth: 1920, CGHeight: 1080,
			Scale: 1.0, Surface: appuseSurface{W: 1920, H: 1080},
		},
	}
	displays := darwinBuildDisplayLayout(raw)
	if len(displays) != 3 {
		t.Fatalf("expected 3 displays, got %d", len(displays))
	}

	// Ensure all surfaces are strictly disjoint in physical pixel space.
	for i := 0; i < len(displays); i++ {
		for j := i + 1; j < len(displays); j++ {
			a, b := displays[i].Surface, displays[j].Surface
			overlapX := int64(a.X) < int64(b.X)+int64(b.W) && int64(b.X) < int64(a.X)+int64(a.W)
			overlapY := int64(a.Y) < int64(b.Y)+int64(b.H) && int64(b.Y) < int64(a.Y)+int64(a.H)
			if overlapX && overlapY {
				t.Fatalf("display surfaces overlap: %+v and %+v", a, b)
			}
		}
	}

	// Verify round-trip CG -> Physical -> CG across all 3 displays.
	cases := []struct {
		name      string
		cgX, cgY  float64
		wantMonID uint32
	}{
		{"main-retina", 320.5, 450.5, 0},
		{"left-negative-1x", -500.0, 220.0, 1},
		{"right-1x", 1800.0, 600.0, 2},
	}
	for _, tc := range cases {
		pt, monID := darwinCGPointToPhysical(displays, tc.cgX, tc.cgY)
		if monID != tc.wantMonID {
			t.Fatalf("%s: got monitor %d, want %d", tc.name, monID, tc.wantMonID)
		}
		gotX, gotY := darwinPhysicalToCG(displays, pt.X, pt.Y)
		if math.Abs(gotX-tc.cgX) > 1.0 || math.Abs(gotY-tc.cgY) > 1.0 {
			t.Fatalf("%s: round-trip (%g,%g) -> (%d,%d) -> (%g,%g)", tc.name, tc.cgX, tc.cgY, pt.X, pt.Y, gotX, gotY)
		}
	}

	// Verify negative-coordinate window rect conversion preserves coordinates and size.
	px, py, pw, ph, monID := darwinCGRectToPhysical(displays, -1600, 100, 800, 600)
	if monID != 1 || px >= 0 || py != 100 || pw != 800 || ph != 600 {
		t.Fatalf("unexpected left-monitor rect: (%d,%d %dx%d) mon=%d", px, py, pw, ph, monID)
	}

	// Verify Retina window rect doubles logical points.
	px, py, pw, ph, monID = darwinCGRectToPhysical(displays, 100, 50, 400, 300)
	if monID != 0 || px != 200 || py != 100 || pw != 800 || ph != 600 {
		t.Fatalf("unexpected retina rect: (%d,%d %dx%d) mon=%d", px, py, pw, ph, monID)
	}

	// Verify Top-Left CG Y <-> Bottom-Left AppKit Y conversion.
	if appkitY := darwinCGToAppKitY(900, 60, 780); appkitY != 60 {
		t.Fatalf("darwinCGToAppKitY(900, 60, 780) = %g, want 60", appkitY)
	}
}

func TestDarwinKeyMapping(t *testing.T) {
	valid := []string{
		"enter", "return", "tab", "escape", "esc", "space", "backspace", "delete",
		"left", "arrowleft", "up", "arrowup", "right", "arrowright", "down", "arrowdown",
		"home", "end", "pageup", "pagedown",
		"ctrl", "control", "alt", "option", "shift", "cmd", "command", "meta", "super", "win",
		"f1", "f12", "f20", "a", "z", "0", "9",
	}
	for _, name := range valid {
		if _, err := appuseKeyOf(name); err != nil {
			t.Fatalf("expected valid key %q, got error: %v", name, err)
		}
	}
	for _, bad := range []string{"", "hyper", "f25", "unknown", "ctrl+a"} {
		if _, err := appuseKeyOf(bad); err == nil {
			t.Fatalf("expected error for invalid key %q", bad)
		}
	}
}

func TestDarwinPhysicalEscFilter(t *testing.T) {
	if !isPhysicalEscEvent(53, 0) {
		t.Fatal("physical Esc (keyCode=53, userData=0) must be recognized")
	}
	if isPhysicalEscEvent(53, vegaInjectedEventTagC) {
		t.Fatal("program-injected Esc carrying VEGA tag must be ignored")
	}
	if isPhysicalEscEvent(36, 0) {
		t.Fatal("non-Esc keyCode must not trigger Esc emergency stop")
	}
}

func TestDarwinAXRoleNormalize(t *testing.T) {
	cases := map[string]string{
		"AXButton":            "button",
		"AXTextField":         "textbox",
		"AXTextArea":          "textbox",
		"AXCheckBox":          "checkbox",
		"AXRadioButton":       "radiobutton",
		"AXPopUpButton":       "combobox",
		"AXComboBox":          "combobox",
		"AXLink":              "link",
		"AXMenuItem":          "menuitem",
		"AXStaticText":        "text",
		"AXWindow":            "window",
		"AXProgressIndicator": "progressbar",
		"":                    "custom",
	}
	for raw, want := range cases {
		if got := axRoleNormalize(raw); got != want {
			t.Fatalf("axRoleNormalize(%q) = %q, want %q", raw, got, want)
		}
	}
}
