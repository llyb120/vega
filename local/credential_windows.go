//go:build windows

package main

import (
	"encoding/base64"
	"fmt"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

func protectToken(token string) (string, error) {
	if token == "" {
		return "", fmt.Errorf("Empty device credential")
	}
	data := []byte(token)
	input := windows.DataBlob{Size: uint32(len(data)), Data: &data[0]}
	var output windows.DataBlob
	if err := windows.CryptProtectData(&input, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &output); err != nil {
		return "", err
	}
	defer windows.LocalFree(windows.Handle(uintptr(unsafe.Pointer(output.Data))))
	return "dpapi:" + base64.StdEncoding.EncodeToString(unsafe.Slice(output.Data, output.Size)), nil
}
func unprotectToken(token string) (string, error) {
	if !strings.HasPrefix(token, "dpapi:") {
		return "", fmt.Errorf("Invalid device credential protection")
	}
	data, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(token, "dpapi:"))
	if err != nil || len(data) == 0 {
		return "", fmt.Errorf("Invalid device credential")
	}
	input := windows.DataBlob{Size: uint32(len(data)), Data: &data[0]}
	var output windows.DataBlob
	if err = windows.CryptUnprotectData(&input, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &output); err != nil {
		return "", err
	}
	defer windows.LocalFree(windows.Handle(uintptr(unsafe.Pointer(output.Data))))
	return string(unsafe.Slice(output.Data, output.Size)), nil
}
