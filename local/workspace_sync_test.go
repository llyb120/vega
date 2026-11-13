package main

import (
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

func TestWorkspaceSyncWriteProtectsChangedFiles(t *testing.T) {
	root := t.TempDir()
	write := func(path, content, expected string) map[string]any {
		return fileOperation(fileReq{Op: "sync_write", Cwd: root, Path: path, Content: base64.StdEncoding.EncodeToString([]byte(content)), ExpectedHash: expected})
	}
	if result := write("nested/note.txt", "first", ""); result["error"] != nil {
		t.Fatal(result)
	}
	if result := write("nested/note.txt", "overwrite", ""); result["error"] == nil {
		t.Fatal("an existing file must not be treated as absent")
	}
	if result := write("nested/note.txt", "overwrite", fmt.Sprintf("%x", sha256.Sum256([]byte("wrong")))); result["error"] == nil {
		t.Fatal("a changed file must not be overwritten")
	}
	if result := write("nested/note.txt", "updated", fmt.Sprintf("%x", sha256.Sum256([]byte("first")))); result["error"] != nil {
		t.Fatal(result)
	}
	data, err := os.ReadFile(filepath.Join(root, "nested", "note.txt"))
	if err != nil || string(data) != "updated" {
		t.Fatalf("unexpected content %q: %v", data, err)
	}
	for _, path := range []string{"../outside.txt", "nested/../outside.txt", filepath.Join(root, "absolute.txt")} {
		if result := write(path, "outside", ""); result["error"] == nil {
			t.Fatalf("outside path accepted: %q", path)
		}
	}
}

func TestWorkspaceSyncWriteRejectsSymlinkParents(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	link := filepath.Join(root, "link")
	if err := os.Symlink(outside, link); err != nil {
		if runtime.GOOS != "windows" {
			t.Skipf("cannot create a directory symlink: %v", err)
		}
		if output, junctionErr := exec.Command("cmd", "/c", "mklink", "/J", link, outside).CombinedOutput(); junctionErr != nil {
			t.Skipf("cannot create a directory junction: %v (%s)", junctionErr, output)
		}
	}
	result := fileOperation(fileReq{Op: "sync_write", Cwd: root, Path: "link/escape.txt", Content: base64.StdEncoding.EncodeToString([]byte("outside"))})
	if result["error"] == nil {
		t.Fatal("sync must not follow a symlink parent")
	}
	if _, err := os.Stat(filepath.Join(outside, "escape.txt")); !os.IsNotExist(err) {
		t.Fatalf("sync wrote outside the workspace: %v", err)
	}
}
