package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"os/exec"
	"runtime"
	"sync"
	"time"
)

type execPollReq struct {
	JobID string `json:"jobId"`
	Wait  int    `json:"wait"`
}

type bashJob struct {
	id     string
	cmd    *exec.Cmd
	cancel context.CancelFunc
	output *limitedOutput
	done   chan struct{}
	mu     sync.Mutex
	result map[string]any
}

var bashRegistry = struct {
	sync.Mutex
	jobs map[string]*bashJob
}{jobs: map[string]*bashJob{}}

func newJobID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return hex.EncodeToString([]byte(time.Now().Format("150405.000000000")))
	}
	return hex.EncodeToString(b[:])
}

func registerBashJob(job *bashJob) {
	bashRegistry.Lock()
	defer bashRegistry.Unlock()
	bashRegistry.jobs[job.id] = job
}

func lookupBashJob(id string) *bashJob {
	bashRegistry.Lock()
	defer bashRegistry.Unlock()
	return bashRegistry.jobs[id]
}

func removeBashJob(id string) {
	bashRegistry.Lock()
	defer bashRegistry.Unlock()
	delete(bashRegistry.jobs, id)
}

func killAllBashJobs() {
	bashRegistry.Lock()
	jobs := make([]*bashJob, 0, len(bashRegistry.jobs))
	for _, job := range bashRegistry.jobs {
		jobs = append(jobs, job)
	}
	bashRegistry.Unlock()
	for _, job := range jobs {
		job.cancel()
	}
}

func commandResult(cmd *exec.Cmd, output *limitedOutput, err error, cancelled bool) map[string]any {
	code := 0
	message := ""
	if err != nil {
		code = -1
		if exit, ok := err.(*exec.ExitError); ok {
			code = exit.ExitCode()
		} else {
			message = err.Error()
		}
	}
	if cancelled {
		code = -1
		message = "Cancelled/timeout"
	}
	output.mu.Lock()
	text, truncated := output.data.String(), output.truncated
	output.mu.Unlock()
	return map[string]any{"output": text, "truncated": truncated, "exitCode": code, "error": message}
}

func startShellCommand(ctx context.Context, req execReq) (*exec.Cmd, *limitedOutput, error) {
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		shell := os.Getenv("VEGA_POWERSHELL")
		if shell == "" {
			shell = "powershell.exe"
		}
		cmd = exec.CommandContext(ctx, shell, "-NoProfile", "-NonInteractive", "-Command", req.Command)
	} else {
		cmd = exec.CommandContext(ctx, "/bin/sh", "-c", req.Command)
	}
	cmd.Dir = req.Cwd
	configureCommand(cmd)
	cmd.WaitDelay = 2 * time.Second
	output := &limitedOutput{}
	cmd.Stdout = output
	cmd.Stderr = output
	return cmd, output, cmd.Start()
}

func runCommandYield(parent context.Context, req execReq) map[string]any {
	processCtx, stop := context.WithCancel(context.Background())
	deadline := time.AfterFunc(time.Duration(req.Timeout)*time.Second, stop)
	cmd, output, err := startShellCommand(processCtx, req)
	if err != nil {
		deadline.Stop()
		stop()
		return failure(err.Error())
	}
	finished := make(chan error, 1)
	go func() { finished <- cmd.Wait() }()
	yield := time.Duration(req.YieldSecs) * time.Second
	timer := time.NewTimer(yield)
	defer timer.Stop()
	select {
	case err := <-finished:
		deadline.Stop()
		stop()
		return commandResult(cmd, output, err, processCtx.Err() != nil || parent.Err() != nil)
	case <-parent.Done():
		deadline.Stop()
		stop()
		err := <-finished
		return commandResult(cmd, output, err, true)
	case <-timer.C:
		id := req.JobID
		if id == "" {
			id = newJobID()
		}
		job := &bashJob{id: id, cmd: cmd, cancel: func() { deadline.Stop(); stop() }, output: output, done: make(chan struct{})}
		registerBashJob(job)
		go func() {
			err := <-finished
			job.mu.Lock()
			job.result = commandResult(cmd, output, err, processCtx.Err() != nil)
			job.mu.Unlock()
			close(job.done)
			time.AfterFunc(60*time.Second, func() { removeBashJob(id) })
		}()
		output.mu.Lock()
		text, truncated := output.data.String(), output.truncated
		output.mu.Unlock()
		return map[string]any{"jobId": id, "running": true, "output": text, "truncated": truncated, "error": ""}
	}
}

func pollBashJob(req execPollReq, parent context.Context) map[string]any {
	job := lookupBashJob(req.JobID)
	if job == nil {
		return failure("没有后台任务 " + req.JobID + "：可能已结束并被清理")
	}
	wait := req.Wait
	if wait < 1 {
		wait = 30
	}
	if wait > 600 {
		wait = 600
	}
	timer := time.NewTimer(time.Duration(wait) * time.Second)
	defer timer.Stop()
	select {
	case <-job.done:
		job.mu.Lock()
		result := job.result
		job.mu.Unlock()
		removeBashJob(job.id)
		return result
	case <-parent.Done():
		return runningTail(job)
	case <-timer.C:
		return runningTail(job)
	}
}

func runningTail(job *bashJob) map[string]any {
	job.output.mu.Lock()
	text, truncated := job.output.data.String(), job.output.truncated
	job.output.mu.Unlock()
	return map[string]any{"running": true, "jobId": job.id, "output": text, "truncated": truncated, "error": ""}
}

func killBashJob(id string) map[string]any {
	job := lookupBashJob(id)
	if job == nil {
		return failure("没有后台任务 " + id + "：可能已结束并被清理")
	}
	job.cancel()
	select {
	case <-job.done:
		job.mu.Lock()
		result := job.result
		job.mu.Unlock()
		removeBashJob(job.id)
		return result
	case <-time.After(3 * time.Second):
		return runningTail(job)
	}
}
