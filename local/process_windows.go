//go:build windows

package main

import (
	"os/exec"
	"strconv"
)

func configureCommand(cmd *exec.Cmd) {
	cmd.Cancel = func() error {
		return exec.Command("taskkill", "/PID", strconv.Itoa(cmd.Process.Pid), "/T", "/F").Run()
	}
}
