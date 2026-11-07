package main

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// 任务工作区清单：只列业务文件，依赖/构建产物/凭据不参与交接。
// 与服务端 shared/workspace-sync.mjs 的排除规则保持一致；超限明确失败，不静默裁剪。
const (
	maxSyncFiles    = 2000
	maxSyncFileSize = 4 << 20
	maxSyncBytes    = 16 << 20
)

var skippedDirs = map[string]bool{
	".git": true, "node_modules": true, ".venv": true, "venv": true, "dist": true, "build": true,
	"out": true, "target": true, "bin": true, ".next": true, ".nuxt": true, ".cache": true,
	"__pycache__": true, ".gradle": true, ".pytest_cache": true, ".ssh": true, ".aws": true,
}

var skippedSuffixes = []string{".pem", ".key", ".pfx", ".p12", ".keystore"}

var skippedNames = map[string]bool{".npmrc": true, ".netrc": true, "id_rsa": true}

func skipSyncPath(name, rel string) bool {
	if skippedDirs[name] || skippedNames[name] {
		return true
	}
	if strings.HasPrefix(name, ".env") {
		return true
	}
	lower := strings.ToLower(rel)
	for _, suffix := range skippedSuffixes {
		if strings.HasSuffix(lower, suffix) {
			return true
		}
	}
	return false
}

var errWorkspaceTooLarge = errors.New("workspace exceeds the handoff limit")

// listWorkspace 返回相对 root 的文件清单（路径统一用 /），供服务端比较与增量同步。
func listWorkspace(root string) map[string]any {
	abs, err := filepath.Abs(root)
	if err != nil {
		return failure(err.Error())
	}
	st, err := os.Stat(abs)
	if err != nil || !st.IsDir() {
		return failure("cwd must be an existing directory on this machine")
	}
	files := make([]map[string]any, 0, 128)
	var total int64
	err = filepath.WalkDir(abs, func(path string, entry fs.DirEntry, walk error) error {
		if walk != nil {
			return nil // 无权限的条目跳过，不让整次清单失败
		}
		rel, relErr := filepath.Rel(abs, path)
		if relErr != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if rel == "." {
			return nil
		}
		if entry.IsDir() {
			if skipSyncPath(entry.Name(), rel) {
				return fs.SkipDir
			}
			return nil
		}
		if !entry.Type().IsRegular() || skipSyncPath(entry.Name(), rel) {
			return nil
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			return nil
		}
		if info.Size() > maxSyncFileSize {
			return errors.New("文件过大，无法交接：" + rel)
		}
		if len(files) >= maxSyncFiles || total+info.Size() > maxSyncBytes {
			return errWorkspaceTooLarge
		}
		total += info.Size()
		files = append(files, map[string]any{"path": rel, "size": info.Size(), "mtime": info.ModTime().UnixMilli()})
		return nil
	})
	if err != nil {
		if errors.Is(err, errWorkspaceTooLarge) {
			return failure("工作区超过交接上限（2000 文件 / 16MiB），请缩小范围后再交接")
		}
		return failure(err.Error())
	}
	sort.Slice(files, func(i, j int) bool { return files[i]["path"].(string) < files[j]["path"].(string) })
	return map[string]any{"root": abs, "files": files, "bytes": total}
}
