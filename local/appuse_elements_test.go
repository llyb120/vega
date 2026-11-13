package main

import (
	"image"
	"testing"
	"time"
)

func TestAppuseElementsMapRectanglesWithoutLosingNegativeScreenCoordinates(t *testing.T) {
	shot := appuseTestShot()
	shot.Surface.X = -1920
	r := appuseControlRect{X: -1720, Y: 100, Width: 200, Height: 80}
	mapped, ok := appuseControlImageRect(r, shot)
	if !ok || mapped != (appuseControlRect{X: 100, Y: 50, Width: 100, Height: 40}) {
		t.Fatalf("scaled rect: %+v %v", mapped, ok)
	}
	shot.Region = &appuseRegion{X: 100, Y: 50, Width: 800, Height: 400}
	shot.PixelsW, shot.PixelsH = 400, 200
	mapped, ok = appuseControlImageRect(r, shot)
	if !ok || mapped != (appuseControlRect{X: 50, Y: 25, Width: 100, Height: 40}) {
		t.Fatalf("cropped rect: %+v %v", mapped, ok)
	}
	if _, ok := appuseControlImageRect(appuseControlRect{X: 5000, Y: 100, Width: 20, Height: 20}, shot); ok {
		t.Fatal("off-image controls must not become clickable image coordinates")
	}
	shot.Screen = true
	x, y := -1720, 123
	point, err := appusePointOf(shot, &x, &y)
	if err != nil || point != (appusePoint{X: -1720, Y: 123}) {
		t.Fatalf("screen point was rescaled: %+v %v", point, err)
	}
}
func TestAppuseScreenInputRequiresItsOwnUnconsumedControlObservation(t *testing.T) {
	windowShot := appuseTestShot()
	windowShot.WindowID = uint32Ptr(42)
	if _, ok := appuseControlImageRect(appuseControlRect{X: 20, Y: 20, Width: 20, Height: 20}, windowShot); ok {
		t.Fatal("window-only captures cannot claim monitor-relative image coordinates")
	}
	old := appuseElementsLast
	defer func() { appuseElementsLast = old }()
	window := uint32(42)
	baseline := &appuseSnapshot{Owner: "one", Taken: time.Now(), GuardFrames: map[uint32]*image.RGBA{}}
	for _, surface := range []appuseSurface{{ID: 0, X: -1920, Y: 0, W: 1920, H: 1080}, {ID: 1, X: 0, Y: 0, W: 1920, H: 1080}} {
		baseline.Shots = append(baseline.Shots, appuseShot{Screen: true, Surface: surface, Monitor: surface.ID, WindowID: &window})
	}
	appuseElementsLast = &appuseElementObservation{Owner: "one", Window: appuseWindow{ID: window}, Snapshot: baseline}
	request := &appuseRequest{Owner: "one", CoordinateSpace: "screen", Actions: []appuseAction{{Action: "drag", X: intPtr(-100), Y: intPtr(100), ToX: intPtr(100), ToY: intPtr(100)}}}
	if got, err := appuseScreenSnapshot(request); err != nil || got != baseline {
		t.Fatalf("valid physical points: %v", err)
	}
	for _, patch := range []func(*appuseRequest){
		func(r *appuseRequest) { r.Owner = "other" },
		func(r *appuseRequest) { r.SnapshotID = "old-image" },
		func(r *appuseRequest) { r.ImageID = "monitor-0" },
		func(r *appuseRequest) { r.WindowID = uint32Ptr(99) },
		func(r *appuseRequest) { r.Actions = []appuseAction{{Action: "press", Key: stringPtr("Enter")}} },
		func(r *appuseRequest) { r.Actions = []appuseAction{{Action: "click", X: intPtr(4000), Y: intPtr(100)}} },
		func(r *appuseRequest) {
			r.Actions = []appuseAction{{Action: "drag", X: intPtr(0), Y: intPtr(10), ToX: intPtr(0), ToY: intPtr(-100)}}
		},
	} {
		copy := *request
		patch(&copy)
		if _, err := appuseScreenSnapshot(&copy); err == nil {
			t.Fatalf("unsafe request accepted: %+v", copy)
		}
	}
	baseline.Invalidated = "already used"
	if _, err := appuseScreenSnapshot(request); err == nil {
		t.Fatal("cannot reuse a consumed observation")
	}
	baseline.Invalidated = ""
	baseline.Taken = time.Now().Add(-appuseSnapshotTTL - time.Second)
	if _, err := appuseScreenSnapshot(request); err == nil {
		t.Fatal("cannot use expired controls")
	}
}
func uint32Ptr(value uint32) *uint32 { return &value }
func TestAppuseElementsRejectAmbiguousQueriesBeforeReadingTheDesktop(t *testing.T) {
	for _, request := range []appuseRequest{
		{X: intPtr(1)}, {X: intPtr(1), Y: intPtr(2), WindowID: uint32Ptr(42)}, {Depth: -1}, {Depth: 21}, {MaxItems: -1}, {MaxItems: 201},
	} {
		if appuseElementsOperation(&request)["error"] == nil {
			t.Fatalf("invalid query accepted: %+v", request)
		}
	}
}
func TestAppuseScreenControlSelectsTheSmallestObservedTarget(t *testing.T) {
	controls := []appuseControl{
		{Name: "window", Enabled: true, Rect: appuseControlRect{X: -200, Y: 0, Width: 200, Height: 200}},
		{Name: "disabled button", Enabled: false, Rect: appuseControlRect{X: -100, Y: 20, Width: 50, Height: 30}},
	}
	got := appuseScreenControl(controls, -90, 25)
	if got == nil || got.Name != "disabled button" || got.Enabled {
		t.Fatalf("disabled target must not fall through to the window: %+v", got)
	}
	if appuseScreenControl(controls, 100, 100) != nil {
		t.Fatal("unobserved points must not be guessed")
	}
}
