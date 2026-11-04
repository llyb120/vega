package main

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
)

// Private keys from an employee's vault (ssh_key entries): written 0600 under the user's temp directory for one run and
// removed by the server when the run ends; clearKeys removes whatever a crash or kill left behind.
var keyDir = filepath.Join(os.TempDir(), "vega-keys")

type keyReq struct {
	Op      string `json:"op"`
	Path    string `json:"path"`
	Content string `json:"content"`
}

func keyOperation(req keyReq) map[string]any {
	switch req.Op {
	case "write":
		data, err := base64.StdEncoding.DecodeString(req.Content)
		if err != nil || len(data) == 0 || len(data) > 64<<10 {
			return failure("Invalid key content")
		}
		if err = os.MkdirAll(keyDir, 0700); err == nil {
			err = os.Chmod(keyDir, 0700)
		}
		if err != nil {
			return failure(err.Error())
		}
		f, err := os.CreateTemp(keyDir, "key-*")
		if err != nil {
			return failure(err.Error())
		}
		if err = f.Chmod(0600); err == nil {
			_, err = f.Write(data)
		}
		if closeErr := f.Close(); err == nil {
			err = closeErr
		}
		if err != nil {
			_ = os.Remove(f.Name())
			return failure(err.Error())
		}
		return map[string]any{"path": f.Name()}
	case "remove":
		path := filepath.Clean(req.Path)
		if filepath.Dir(path) != keyDir || !strings.HasPrefix(filepath.Base(path), "key-") {
			return failure("Not a Vega key file")
		}
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return failure(err.Error())
		}
		return map[string]any{"removed": true}
	}
	return failure("Unknown key operation")
}

func clearKeys() { _ = os.RemoveAll(keyDir) }
