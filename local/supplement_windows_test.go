//go:build windows

package main

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"
)

func TestSupplementDialogScriptParses(t *testing.T) {
	cmd := exec.CommandContext(context.Background(), "powershell.exe", "-NoLogo", "-NoProfile", "-Command", `[Console]::InputEncoding = [Text.UTF8Encoding]::new($false); $tokens = $null; $parseErrors = $null; $null = [Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$tokens, [ref]$parseErrors); if ($parseErrors.Count) { $parseErrors | ForEach-Object { $_.Message }; exit 1 }`)
	cmd.Stdin = strings.NewReader(supplementDialogScript)
	configureCommand(cmd)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("invalid native dialog script: %v\n%s", err, output)
	}
}

func TestSupplementNativeDialog(t *testing.T) {
	if os.Getenv("VEGA_TEST_SUPPLEMENT_DIALOG") != "1" {
		t.Skip("opt-in interactive native dialog check")
	}
	text, confirmed, err := promptSupplement("原有项目目录：D:\\code\\demo\r\n保留其他项目说明。")
	if err != nil || !confirmed || strings.ReplaceAll(text, "\r\n", "\n") != "项目目录：D:\\code\\native-test\n第二行：中文与路径" {
		t.Fatalf("native Save did not preserve multiline Unicode text: confirmed=%v, error=%v", confirmed, err)
	}
	_, confirmed, err = promptSupplement(text)
	if err != nil || confirmed {
		t.Fatalf("native Cancel must not confirm a change: confirmed=%v, error=%v", confirmed, err)
	}
}
