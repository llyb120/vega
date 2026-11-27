//go:build darwin && cgo

package main

/*
#cgo LDFLAGS: -framework Security -framework CoreFoundation
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <stdlib.h>

static OSStatus vega_keychain_set(const char *service, const char *account, const void *data, int dataLen) {
	CFStringRef svc = CFStringCreateWithCString(kCFAllocatorDefault, service, kCFStringEncodingUTF8);
	CFStringRef acct = CFStringCreateWithCString(kCFAllocatorDefault, account, kCFStringEncodingUTF8);
	CFDataRef val = CFDataCreate(kCFAllocatorDefault, (const UInt8 *)data, dataLen);
	if (!svc || !acct || !val) {
		if (svc) CFRelease(svc);
		if (acct) CFRelease(acct);
		if (val) CFRelease(val);
		return errSecParam;
	}

	const void *keys[] = { kSecClass, kSecAttrService, kSecAttrAccount, kSecValueData };
	const void *vals[] = { kSecClassGenericPassword, svc, acct, val };
	CFDictionaryRef addQuery = CFDictionaryCreate(kCFAllocatorDefault, keys, vals, 4,
		&kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);

	OSStatus status = SecItemAdd(addQuery, NULL);
	if (status == errSecDuplicateItem) {
		const void *qKeys[] = { kSecClass, kSecAttrService, kSecAttrAccount };
		const void *qVals[] = { kSecClassGenericPassword, svc, acct };
		CFDictionaryRef query = CFDictionaryCreate(kCFAllocatorDefault, qKeys, qVals, 3,
			&kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
		const void *uKeys[] = { kSecValueData };
		const void *uVals[] = { val };
		CFDictionaryRef attrs = CFDictionaryCreate(kCFAllocatorDefault, uKeys, uVals, 1,
			&kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
		status = SecItemUpdate(query, attrs);
		CFRelease(query);
		CFRelease(attrs);
	}
	CFRelease(addQuery);
	CFRelease(svc);
	CFRelease(acct);
	CFRelease(val);
	return status;
}

static OSStatus vega_keychain_get(const char *service, const char *account, char **outBuf, int *outLen) {
	*outBuf = NULL;
	*outLen = 0;
	CFStringRef svc = CFStringCreateWithCString(kCFAllocatorDefault, service, kCFStringEncodingUTF8);
	CFStringRef acct = CFStringCreateWithCString(kCFAllocatorDefault, account, kCFStringEncodingUTF8);
	if (!svc || !acct) {
		if (svc) CFRelease(svc);
		if (acct) CFRelease(acct);
		return errSecParam;
	}

	const void *keys[] = { kSecClass, kSecAttrService, kSecAttrAccount, kSecReturnData, kSecMatchLimit };
	const void *vals[] = { kSecClassGenericPassword, svc, acct, kCFBooleanTrue, kSecMatchLimitOne };
	CFDictionaryRef query = CFDictionaryCreate(kCFAllocatorDefault, keys, vals, 5,
		&kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);

	CFTypeRef result = NULL;
	OSStatus status = SecItemCopyMatching(query, &result);
	CFRelease(query);
	CFRelease(svc);
	CFRelease(acct);

	if (status == errSecSuccess && result != NULL) {
		CFDataRef data = (CFDataRef)result;
		CFIndex len = CFDataGetLength(data);
		if (len > 0) {
			char *buf = (char *)malloc((size_t)len);
			if (buf) {
				CFDataGetBytes(data, CFRangeMake(0, len), (UInt8 *)buf);
				*outBuf = buf;
				*outLen = (int)len;
			} else {
				status = errSecAllocate;
			}
		}
		CFRelease(result);
	}
	return status;
}
*/
import "C"

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unsafe"
)

const (
	keychainServiceName = "com.vega.local.device-token"
	keychainPrefix      = "keychain:"
	keychainMemPrefix   = "keychain-mem:"
)

func credentialSkipRealKeychain() bool {
	if os.Getenv("VEGA_TEST_KEYCHAIN_MEM") == "1" {
		return true
	}
	// Do not pollute the user's real login keychain or trigger ACL prompts across ephemeral `go test` binaries.
	if flag.Lookup("test.v") != nil || strings.HasSuffix(filepath.Base(os.Args[0]), ".test") {
		return true
	}
	return false
}

func protectToken(token string) (string, error) {
	if token == "" {
		return "", fmt.Errorf("Empty device credential")
	}
	if !credentialSkipRealKeychain() {
		sum := sha256.Sum256([]byte(token))
		account := hex.EncodeToString(sum[:])[:24]
		cSvc := C.CString(keychainServiceName)
		cAcct := C.CString(account)
		cData := C.CBytes([]byte(token))
		status := C.vega_keychain_set(cSvc, cAcct, cData, C.int(len(token)))
		C.free(unsafe.Pointer(cSvc))
		C.free(unsafe.Pointer(cAcct))
		C.free(cData)
		if status == 0 {
			return keychainPrefix + account, nil
		}
	}
	return keychainMemPrefix + base64.RawURLEncoding.EncodeToString([]byte(token)), nil
}

func unprotectToken(token string) (string, error) {
	if strings.HasPrefix(token, keychainPrefix) {
		account := strings.TrimPrefix(token, keychainPrefix)
		if account == "" {
			return "", fmt.Errorf("Invalid device credential protection")
		}
		cSvc := C.CString(keychainServiceName)
		cAcct := C.CString(account)
		var outBuf *C.char
		var outLen C.int
		status := C.vega_keychain_get(cSvc, cAcct, &outBuf, &outLen)
		C.free(unsafe.Pointer(cSvc))
		C.free(unsafe.Pointer(cAcct))
		if status != 0 || outBuf == nil || outLen <= 0 {
			if outBuf != nil {
				C.free(unsafe.Pointer(outBuf))
			}
			return "", fmt.Errorf("Invalid device credential protection")
		}
		raw := C.GoBytes(unsafe.Pointer(outBuf), outLen)
		C.free(unsafe.Pointer(outBuf))
		return string(raw), nil
	}
	if strings.HasPrefix(token, keychainMemPrefix) {
		raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(token, keychainMemPrefix))
		if err != nil || len(raw) == 0 {
			return "", fmt.Errorf("Invalid device credential protection")
		}
		return string(raw), nil
	}
	// Smooth upgrade from legacy plaintext Unix configurations (device secrets are >=16 chars without prefix).
	if len(token) >= 16 && !strings.Contains(token, ":") {
		return token, nil
	}
	return "", fmt.Errorf("Invalid device credential protection")
}
