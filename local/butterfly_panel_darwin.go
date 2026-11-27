//go:build darwin && cgo

package main

// macOS 对话窗启动在独立进程，WKWebView 异常不会带走菜单栏托盘和正在跑的任务。

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	butterflyPanelTitle        = "牵牛星"
	butterflyPanelWidth        = 1080
	butterflyPanelHeight       = 780
	butterflyPanelMinWidth     = 560
	butterflyPanelMinHeight    = 420
	butterflyPanelMargin       = 8
	butterflyPanelGeometryFile = "panel-window.json"
	butterflyPanelSocketFile   = "panel.sock"
)

type appuseWinRect struct{ Left, Top, Right, Bottom int32 }

type appuseWinPoint struct{ X, Y int32 }

type panelGeometry struct {
	X, Y, Width, Height int32
}

// A single owned child serves both the main window and its connection settings.
var butterflyPanelSpawn struct {
	sync.Mutex
	process *os.Process
	done    chan struct{}
	closing bool
}

func butterflyScale(value int32, dpi uint32) int32 { return value * int32(dpi) / 96 }

func butterflyPanelSocketPath() string {
	return filepath.Join(butterflyPanelDataDir(), butterflyPanelSocketFile)
}

func panelSendCommand(cmd string) bool {
	sock := butterflyPanelSocketPath()
	conn, err := net.DialTimeout("unix", sock, 300*time.Millisecond)
	if err != nil {
		return false
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(500 * time.Millisecond))
	if _, err := fmt.Fprintln(conn, cmd); err != nil {
		return false
	}
	line, err := bufio.NewReader(conn).ReadString('\n')
	return err == nil && strings.TrimSpace(line) == "ok"
}

// butterflyPanelOpen launches the app or restores its existing window.
func butterflyPanelOpen(url string) bool {
	if url == "" {
		return false
	}
	butterflyPanelSpawn.Lock()
	defer butterflyPanelSpawn.Unlock()
	if butterflyPanelSpawn.closing {
		return true
	}
	if panelSendCommand("show") {
		return true
	}
	if butterflyPanelSpawn.process == nil {
		return butterflyPanelLaunch(url)
	}
	// During WKWebView startup the requested URL is already in panel-target.txt.
	return true
}

func butterflyPanelLaunch(url string) bool {
	executable, err := os.Executable()
	if err != nil {
		return false
	}
	command := exec.Command(executable, "--butterfly-panel", url)
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := command.Start(); err != nil {
		return false
	}
	done := make(chan struct{})
	butterflyPanelSpawn.process, butterflyPanelSpawn.done = command.Process, done
	go func() {
		_ = command.Wait()
		butterflyPanelSpawn.Lock()
		butterflyPanelSpawn.process, butterflyPanelSpawn.done = nil, nil
		butterflyPanelSpawn.Unlock()
		close(done)
	}()
	return true
}

// Closing the window hides it; exiting from the tray ends the owned child too.
func butterflyPanelClose() {
	butterflyPanelSpawn.Lock()
	butterflyPanelSpawn.closing = true
	process, done := butterflyPanelSpawn.process, butterflyPanelSpawn.done
	butterflyPanelSpawn.Unlock()
	if process == nil {
		return
	}
	if panelSendCommand("shutdown") {
		select {
		case <-done:
			return
		case <-time.After(time.Second):
		}
	}
	_ = process.Kill()
}

func butterflyPanelPark() {
	_ = panelSendCommand("park")
}

// panelLog 面板是独立进程，出问题时只能写主进程的 client.log（同站点数据目录）。
func panelLog(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "vega-local: 蝴蝶面板 "+format+"\n", args...)
	dir := butterflyPanelDataDir()
	if dir == "" {
		return
	}
	file, err := os.OpenFile(filepath.Join(dir, "client.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer file.Close()
	fmt.Fprintf(file, "%s 蝴蝶面板 %s\n", time.Now().Format("2006-01-02 15:04:05"), fmt.Sprintf(format, args...))
}

// butterflyPanelDataDir 与主进程用同一个站点数据目录（读自己旁边的 instance.json）。
func butterflyPanelDataDir() string {
	if executable, err := os.Executable(); err == nil {
		if pin, err := readInstancePin(filepath.Dir(executable)); err == nil {
			if dir, err := siteDataDir(pin.Origin); err == nil {
				return dir
			}
		}
	}
	if base, err := os.UserConfigDir(); err == nil {
		dir := filepath.Join(base, "vega-local")
		_ = os.MkdirAll(dir, 0o700)
		return dir
	}
	return os.TempDir()
}

// butterflyPanelRun 在独立进程里跑面板：锁住主线程初始化 Cocoa 与 WKWebView。
func butterflyPanelRun(url string) bool {
	runtime.LockOSThread()
	return panelHostStart(url)
}

// panelTarget 面板这次要显示的页面：主进程在打开前把地址写到这里（同一个数据目录）。
func panelTarget() string {
	data, err := os.ReadFile(filepath.Join(butterflyPanelDataDir(), "panel-target.txt"))
	if err != nil {
		return ""
	}
	target := strings.TrimSpace(string(data))
	if !strings.HasPrefix(target, "http://"+localAddress+"/") {
		return ""
	}
	return target
}

func panelGeometryPath(dir string) string { return filepath.Join(dir, butterflyPanelGeometryFile) }

func loadPanelGeometry(dir string) (panelGeometry, bool) {
	data, err := os.ReadFile(panelGeometryPath(dir))
	if err != nil {
		return panelGeometry{}, false
	}
	var geometry panelGeometry
	if json.Unmarshal(data, &geometry) != nil || geometry.Width < butterflyPanelMinWidth || geometry.Height < butterflyPanelMinHeight {
		return panelGeometry{}, false
	}
	return geometry, true
}

func savePanelGeometryRect(dir string, x, y, width, height int32) {
	if width < butterflyPanelMinWidth || height < butterflyPanelMinHeight {
		return
	}
	data, err := json.Marshal(panelGeometry{x, y, width, height})
	if err != nil {
		return
	}
	_ = os.WriteFile(panelGeometryPath(dir), data, 0o600)
}

func butterflyPanelFrame(anchor, work appuseWinRect, saved *panelGeometry, dpi uint32) (x, y, width, height int32) {
	margin := butterflyScale(butterflyPanelMargin, dpi)
	width, height = butterflyScale(butterflyPanelWidth, dpi), butterflyScale(butterflyPanelHeight, dpi)
	if saved != nil {
		width, height = saved.Width, saved.Height
	}
	if limit := work.Right - work.Left - 2*margin; limit > 0 && width > limit {
		width = limit
	}
	if limit := work.Bottom - work.Top - 2*margin; limit > 0 && height > limit {
		height = limit
	}
	x = work.Left + (work.Right-work.Left-width)/2
	y = work.Top + (work.Bottom-work.Top-height)/2
	if saved != nil && saved.X >= work.Left && saved.Y >= work.Top && saved.X+saved.Width <= work.Right && saved.Y+saved.Height <= work.Bottom {
		x, y = saved.X, saved.Y
	}
	if x < work.Left+margin {
		x = work.Left + margin
	}
	if y < work.Top+margin {
		y = work.Top + margin
	}
	if x+width > work.Right-margin {
		x = work.Right - margin - width
	}
	if y+height > work.Bottom-margin {
		y = work.Bottom - margin - height
	}
	return x, y, width, height
}

func panelInitialFrame() (x, y, width, height int32) {
	anchor, work, dpi := butterflyAnchorWork()
	saved, ok := loadPanelGeometry(butterflyPanelDataDir())
	if ok {
		return butterflyPanelFrame(anchor, work, &saved, dpi)
	}
	return butterflyPanelFrame(anchor, work, nil, dpi)
}

func panelStartIPC(onShow, onPark, onShutdown func()) net.Listener {
	sock := butterflyPanelSocketPath()
	_ = os.Remove(sock)
	lis, err := net.Listen("unix", sock)
	if err != nil {
		panelLog("监听控制套接字失败：%v", err)
		return nil
	}
	_ = os.Chmod(sock, 0o600)
	go func() {
		for {
			conn, err := lis.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				_ = c.SetDeadline(time.Now().Add(time.Second))
				line, err := bufio.NewReader(c).ReadString('\n')
				if err != nil {
					return
				}
				switch strings.TrimSpace(line) {
				case "show":
					onShow()
					_, _ = fmt.Fprintln(c, "ok")
				case "park":
					onPark()
					_, _ = fmt.Fprintln(c, "ok")
				case "shutdown":
					_, _ = fmt.Fprintln(c, "ok")
					onShutdown()
				}
			}(conn)
		}
	}()
	return lis
}
