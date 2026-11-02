package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

func updateListener() (*net.TCPListener, string, error) {
	listener, err := net.ListenTCP("tcp", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		return nil, "", err
	}
	token := make([]byte, 32)
	if _, err := rand.Read(token); err != nil {
		listener.Close()
		return nil, "", err
	}
	return listener, hex.EncodeToString(token), nil
}
func updateCommand(path string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(context.Background(), path, args...)
	configureCommand(cmd)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	return cmd
}
func startUpdateHelper(ctx context.Context, target string, update *stagedUpdate, instances map[string]string) error {
	listener, token, err := updateListener()
	if err != nil {
		return err
	}
	defer listener.Close()
	state, err := json.Marshal(instances)
	if err != nil {
		return err
	}
	cmd := updateCommand(update.path, "--apply-update", target, listener.Addr().String(), token)
	cmd.Env = append(os.Environ(), "VEGA_LOCAL_RESUME="+string(state))
	if err := cmd.Start(); err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = cmd.Cancel()
			_ = cmd.Wait()
		}
	}()
	_ = listener.SetDeadline(time.Now().Add(10 * time.Second))
	stop := context.AfterFunc(ctx, func() { listener.Close() })
	defer stop()
	conn, err := listener.Accept()
	if err != nil {
		return err
	}
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	ready, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil || ready != token+" "+update.version+"\n" || ctx.Err() != nil {
		conn.Close()
		return fmt.Errorf("update helper readiness failed")
	}
	if _, err := io.WriteString(conn, "commit\n"); err != nil {
		conn.Close()
		return err
	}
	committed = true
	_ = cmd.Process.Release()
	// Keep the connection alive until process exit releases the executable and loopback ports.
	go func() { _, _ = io.Copy(io.Discard, conn); conn.Close() }()
	return nil
}
func applyUpdate(args []string) error {
	if len(args) != 3 || !filepath.IsAbs(args[0]) {
		return fmt.Errorf("invalid update handoff")
	}
	target, address, token := args[0], args[1], args[2]
	staged, err := executablePath()
	if err != nil {
		return err
	}
	if filepath.Dir(target) != filepath.Dir(staged) || target == staged || !strings.HasPrefix(filepath.Base(staged), ".vega-update-") {
		return fmt.Errorf("invalid staged executable")
	}
	conn, err := net.DialTimeout("tcp", address, 5*time.Second)
	if err != nil {
		return err
	}
	_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
	defer conn.Close()
	if _, err := fmt.Fprintf(conn, "%s %s\n", token, clientVersion); err != nil {
		return err
	}
	reader := bufio.NewReader(conn)
	commit, err := reader.ReadString('\n')
	if err != nil || commit != "commit\n" {
		return fmt.Errorf("update not committed")
	}
	// Winsock reports process-exit socket resets as WSAECONNRESET (10054).
	if _, err := reader.ReadByte(); err != io.EOF && !errors.Is(err, syscall.ECONNRESET) && !errors.Is(err, syscall.ECONNABORTED) && !errors.Is(err, syscall.Errno(10054)) {
		return fmt.Errorf("old client did not exit: %w", err)
	}
	err = replaceClient(target, staged, func() error { return launchUpdatedClient(target, staged, "") })
	if err != nil {
		if startErr := launchUpdatedClient(target, staged, clientVersion); startErr != nil {
			return fmt.Errorf("update failed (%v); old client restart failed: %w", err, startErr)
		}
	}
	return err
}

func replaceClient(target, staged string, launch func() error) error {
	info, err := os.Stat(target)
	if err != nil || !info.Mode().IsRegular() {
		return fmt.Errorf("update target must be a regular file")
	}
	candidate, err := os.CreateTemp(filepath.Dir(target), ".vega-install-*")
	if err != nil {
		return err
	}
	name := candidate.Name()
	defer os.Remove(name)
	source, err := os.Open(staged)
	if err != nil {
		candidate.Close()
		return err
	}
	_, copyErr := io.Copy(candidate, source)
	source.Close()
	modeErr := candidate.Chmod(info.Mode().Perm())
	syncErr := candidate.Sync()
	closeErr := candidate.Close()
	for _, err := range []error{copyErr, modeErr, syncErr, closeErr} {
		if err != nil {
			return err
		}
	}
	backup := name + ".old"
	// Windows may release the old image a little after closing its sockets.
	deadline := time.Now().Add(10 * time.Second)
	for {
		err = os.Rename(target, backup)
		if err == nil || time.Now().After(deadline) {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if err != nil {
		return err
	}
	if err := os.Rename(name, target); err == nil {
		err = launch()
		if err == nil {
			os.Remove(backup)
			return nil
		}
		if removeErr := os.Remove(target); removeErr != nil {
			return fmt.Errorf("new client failed (%v); old binary retained at %s: %w", err, backup, removeErr)
		}
		if restoreErr := os.Rename(backup, target); restoreErr != nil {
			return fmt.Errorf("new client failed (%v); restore old binary from %s: %w", err, backup, restoreErr)
		}
		return fmt.Errorf("new client startup failed, old binary restored: %w", err)
	} else {
		if restoreErr := os.Rename(backup, target); restoreErr != nil {
			return fmt.Errorf("replace failed (%v); restore old binary from %s: %w", err, backup, restoreErr)
		}
		return err
	}
}
func launchUpdatedClient(target, staged, failedVersion string) error {
	listener, token, err := updateListener()
	if err != nil {
		return err
	}
	defer listener.Close()
	cmd := updateCommand(target)
	cmd.Env = append(os.Environ(), "VEGA_LOCAL_UPDATE_READY="+listener.Addr().String()+" "+token, "VEGA_LOCAL_UPDATE_CLEANUP="+staged, "VEGA_LOCAL_FAILED_UPDATE="+failedVersion)
	if err := cmd.Start(); err != nil {
		return err
	}
	ok := false
	defer func() {
		if !ok {
			_ = cmd.Cancel()
			_ = cmd.Wait()
		}
	}()
	_ = listener.SetDeadline(time.Now().Add(15 * time.Second))
	conn, err := listener.Accept()
	if err != nil {
		return err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	line, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil || line != token+"\n" {
		return fmt.Errorf("new client startup check failed")
	}
	if _, err := io.WriteString(conn, "ok\n"); err != nil {
		return err
	}
	ok = true
	_ = cmd.Process.Release()
	return nil
}
func notifyUpdateReady() error {
	ready, cleanup := os.Getenv("VEGA_LOCAL_UPDATE_READY"), os.Getenv("VEGA_LOCAL_UPDATE_CLEANUP")
	os.Unsetenv("VEGA_LOCAL_UPDATE_READY")
	os.Unsetenv("VEGA_LOCAL_UPDATE_CLEANUP")
	if ready == "" {
		return nil
	}
	parts := strings.SplitN(ready, " ", 2)
	if len(parts) != 2 {
		return fmt.Errorf("invalid update startup check")
	}
	conn, err := net.DialTimeout("tcp", parts[0], 5*time.Second)
	if err != nil {
		return err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := fmt.Fprintln(conn, parts[1]); err != nil {
		return err
	}
	line, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil || line != "ok\n" {
		return fmt.Errorf("update startup was not acknowledged")
	}
	if target, err := executablePath(); err == nil && cleanup != target && filepath.Dir(cleanup) == filepath.Dir(target) && strings.HasPrefix(filepath.Base(cleanup), ".vega-update-") {
		go func() {
			for i := 0; i < 30; i++ {
				time.Sleep(time.Second)
				if err := os.Remove(cleanup); err == nil || os.IsNotExist(err) {
					return
				}
			}
		}()
	}
	return nil
}
