package main

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/color"
	"image/jpeg"
	"testing"
)

func TestAppuseVisionScaleCapsEdgeAndArea(t *testing.T) {
	if s := appuseVisionScale(800, 600); s != 1.0 {
		t.Fatalf("small image should not upscale, got %v", s)
	}
	s := appuseVisionScale(2560, 1440)
	nw, nh := int(2560*s+0.5), int(1440*s+0.5)
	if nw > 1568 || nh > 1568 || nw*nh > 1_200_000 {
		t.Fatalf("vision scale exceeded cap: %dx%d (scale=%v)", nw, nh, s)
	}
}

func TestAppuseDrawSomRawRendersCollidingBoxesCleanly(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 320, 200))
	for y := 0; y < 200; y++ {
		for x := 0; x < 320; x++ {
			img.SetRGBA(x, y, color.RGBA{240, 240, 240, 255})
		}
	}
	boxes := []appuseSomBox{
		{ID: 1, X: 20, Y: 30, W: 80, H: 28},
		{ID: 2, X: 22, Y: 32, W: 80, H: 28},
		{ID: 12, X: 140, Y: 50, W: 60, H: 24},
	}
	appuseDrawSomRaw(img, boxes)

	// Badge pixels near box 1 & 12 should differ from white background.
	changed := 0
	for y := 10; y < 80; y++ {
		for x := 15; x < 210; x++ {
			c := img.RGBAAt(x, y)
			if c.R < 200 || c.G < 200 || c.B < 200 {
				changed++
			}
		}
	}
	if changed < 60 {
		t.Fatalf("expected visible SoM badges on image, only %d altered pixels", changed)
	}
}

func TestAppuseEncodeJPEGProducesValidJPEG(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 120, 80))
	for y := 0; y < 80; y++ {
		for x := 0; x < 120; x++ {
			img.SetRGBA(x, y, color.RGBA{uint8(x * 2), uint8(y * 3), 120, 255})
		}
	}
	raw, b64, err := appuseEncodeJPEG(img)
	if err != nil {
		t.Fatalf("encode jpeg failed: %v", err)
	}
	if len(raw) < 4 || raw[0] != 0xFF || raw[1] != 0xD8 {
		t.Fatalf("expected JPEG SOI header, got %x", raw[:minInt(4, len(raw))])
	}
	decodedB64, err := base64.StdEncoding.DecodeString(b64)
	if err != nil || !bytes.Equal(raw, decodedB64) {
		t.Fatal("base64 output mismatch")
	}
	if _, err := jpeg.Decode(bytes.NewReader(raw)); err != nil {
		t.Fatalf("jpeg.Decode failed: %v", err)
	}
}

func TestAppuseSomPaletteColorsAreDistinctAndOpaque(t *testing.T) {
	seen := make(map[appuseSomColor]bool)
	for _, pair := range appuseSomPalette {
		if pair[0].A < 200 || pair[1].A == 0 {
			t.Fatalf("unexpected palette alpha: %+v", pair)
		}
		if seen[pair[0]] {
			t.Fatalf("duplicate solid color in palette: %+v", pair[0])
		}
		seen[pair[0]] = true
	}
	if len(seen) != 4 {
		t.Fatalf("expected 4 distinct palette colors, got %d", len(seen))
	}
}

func TestAppuseSomSignatureChangesWhenIDOrRectChanges(t *testing.T) {
	base := []appuseSomBox{
		{ID: 1, X: 20, Y: 30, W: 80, H: 28},
		{ID: 2, X: 140, Y: 50, W: 60, H: 24},
	}
	sigBase := appuseSomSignature(base, 320, 200)
	if sigBase == 0 {
		t.Fatal("expected non-zero SoM signature")
	}
	moved := []appuseSomBox{
		{ID: 1, X: 24, Y: 30, W: 80, H: 28},
		{ID: 2, X: 140, Y: 50, W: 60, H: 24},
	}
	if sigMoved := appuseSomSignature(moved, 320, 200); sigMoved == sigBase {
		t.Fatal("expected SoM signature to change when control rect changes")
	}
	reassigned := []appuseSomBox{
		{ID: 1, X: 20, Y: 30, W: 80, H: 28},
		{ID: 3, X: 140, Y: 50, W: 60, H: 24},
	}
	if sigID := appuseSomSignature(reassigned, 320, 200); sigID == sigBase {
		t.Fatal("expected SoM signature to change when control ID changes")
	}
	if sigResized := appuseSomSignature(base, 640, 400); sigResized == sigBase {
		t.Fatal("expected SoM signature to change when viewport size changes")
	}
}

func TestAppuseDrawSomRawSeparatesDenseOverlappingBadges(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 240, 120))
	for y := 0; y < 120; y++ {
		for x := 0; x < 240; x++ {
			img.SetRGBA(x, y, color.RGBA{245, 245, 245, 255})
		}
	}
	// Tightly overlapping small controls that rely on 8-candidate badge collision avoidance.
	boxes := []appuseSomBox{
		{ID: 1, X: 40, Y: 40, W: 28, H: 20},
		{ID: 2, X: 44, Y: 42, W: 28, H: 20},
		{ID: 3, X: 48, Y: 44, W: 28, H: 20},
		{ID: 4, X: 52, Y: 46, W: 28, H: 20},
	}
	appuseDrawSomRaw(img, boxes)
	// Palette colors 0..3 should appear in rendered pixels.
	paletteHits := 0
	for _, pair := range appuseSomPalette {
		solid := pair[0]
		found := false
		for y := 15; y < 100 && !found; y++ {
			for x := 10; x < 120; x++ {
				c := img.RGBAAt(x, y)
				if absInt(int(c.R)-int(solid.R)) <= 20 && absInt(int(c.G)-int(solid.G)) <= 20 && absInt(int(c.B)-int(solid.B)) <= 20 {
					found = true
					break
				}
			}
		}
		if found {
			paletteHits++
		}
	}
	if paletteHits < 3 {
		t.Fatalf("expected distinct palette colors rendered for dense boxes, got %d hits", paletteHits)
	}
}
