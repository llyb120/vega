package main

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestKeyFiles(t *testing.T) {
	keyDir = filepath.Join(t.TempDir(), "vega-keys")
	r := keyOperation(keyReq{Op: "write", Content: base64.StdEncoding.EncodeToString([]byte("key\n"))})
	path, _ := r["path"].(string)
	if path == "" || filepath.Dir(path) != keyDir {
		t.Fatal("write failed", r)
	}
	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && st.Mode().Perm() != 0600 {
		t.Fatal("key file mode", st.Mode().Perm())
	}
	if data, _ := os.ReadFile(path); string(data) != "key\n" {
		t.Fatal("key content", string(data))
	}
	outside := filepath.Join(t.TempDir(), "key-x")
	_ = os.WriteFile(outside, []byte("x"), 0600)
	if keyOperation(keyReq{Op: "remove", Path: outside})["error"] == nil {
		t.Fatal("removed a file outside the key directory")
	}
	if keyOperation(keyReq{Op: "remove", Path: path})["error"] != nil {
		t.Fatal("remove failed")
	}
	if _, err = os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("key file still exists")
	}
	keyOperation(keyReq{Op: "write", Content: base64.StdEncoding.EncodeToString([]byte("key\n"))})
	clearKeys()
	if _, err = os.Stat(keyDir); !os.IsNotExist(err) {
		t.Fatal("clearKeys left the directory")
	}
}
