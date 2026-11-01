//go:build !windows

package main

// Tokens are stored only in the current user's mode-0600 configuration on Unix.
func protectToken(token string) (string, error)   { return token, nil }
func unprotectToken(token string) (string, error) { return token, nil }
