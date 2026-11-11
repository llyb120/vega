package main

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestRunCommandYieldPollAndKill(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses POSIX sleep")
	}
	dir := t.TempDir()
	started := time.Now()
	result := runCommandYield(context.Background(), execReq{
		Cwd:       dir,
		Command:   "sleep 3; echo done",
		Timeout:   20,
		YieldSecs: 1,
		JobID:     "job-yield",
	})
	if result["running"] != true {
		t.Fatalf("expected background yield, got %#v", result)
	}
	if time.Since(started) > 2*time.Second {
		t.Fatalf("yield took too long: %s", time.Since(started))
	}
	if result["jobId"] != "job-yield" {
		t.Fatalf("job id: %#v", result["jobId"])
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	polled := pollBashJob(execPollReq{JobID: "job-yield", Wait: 4}, ctx)
	if polled["error"] != "" && polled["error"] != nil {
		t.Fatalf("poll error: %#v", polled)
	}
	if polled["running"] == true {
		t.Fatalf("expected finished poll, got %#v", polled)
	}
	if out, _ := polled["output"].(string); out != "done\n" && out != "done" {
		t.Fatalf("output: %#v", polled["output"])
	}
}

func TestRunCommandYieldDetachKeepsProcessAndKillStopsIt(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses POSIX sleep")
	}
	dir := t.TempDir()
	marker := filepath.Join(dir, "survived")
	result := runCommandYield(context.Background(), execReq{
		Cwd:       dir,
		Command:   "sleep 8; echo survived > " + marker,
		Timeout:   20,
		YieldSecs: 1,
		JobID:     "job-kill",
		Detach:    true,
	})
	if result["running"] != true {
		t.Fatalf("expected yield, got %#v", result)
	}
	killed := killBashJob("job-kill")
	if killed["error"] != nil && killed["error"] != "" && killed["running"] == true {
		t.Fatalf("kill did not stop the job: %#v", killed)
	}
	time.Sleep(200 * time.Millisecond)
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("kill must stop the process before it writes the marker")
	}
}

func TestRunCommandWithoutYieldStillBlocksUntilDone(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses POSIX sleep")
	}
	dir := t.TempDir()
	started := time.Now()
	result := runCommand(context.Background(), execReq{
		Cwd:     dir,
		Command: "sleep 1; echo ok",
		Timeout: 5,
	})
	if time.Since(started) < 900*time.Millisecond {
		t.Fatalf("old clients should block until the command finishes: %#v", result)
	}
	if result["running"] == true {
		t.Fatalf("old protocol should not background: %#v", result)
	}
	if result["exitCode"] != 0 {
		t.Fatalf("exit: %#v", result)
	}
}
