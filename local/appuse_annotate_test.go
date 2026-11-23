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
