#!/usr/bin/env bash
set -euo pipefail

# Build and sign Vega.app for macOS.
# Usage:
#   ./scripts/build-macos-app.sh [--out /path/to/Vega.app] [--origin https://your-vega-site]
#
# Environment variables:
#   VEGA_CODESIGN_IDENTITY   Signing identity name in Keychain (default: auto-detect "Vega Local Dev", else ad-hoc "-")
#   VEGA_GOARCH              Target arch: arm64 or amd64 (default: current host arch)

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT_APP="${ROOT_DIR}/Vega.app"
SITE_ORIGIN="${VEGA_ORIGIN:-}"
GOARCH_TARGET="${VEGA_GOARCH:-$(go env GOARCH)}"
VERSION="$(tr -d '[:space:]' < "${ROOT_DIR}/local/VERSION")"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)
      OUT_APP="$2"
      shift 2
      ;;
    --origin)
      SITE_ORIGIN="$2"
      shift 2
      ;;
    -h|--help)
      sed -n '3,12p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

CONTENTS_DIR="${OUT_APP}/Contents"
MACOS_DIR="${CONTENTS_DIR}/MacOS"
RES_DIR="${CONTENTS_DIR}/Resources"

PREV_INSTANCE=""
if [[ -z "${SITE_ORIGIN}" && -f "${RES_DIR}/instance.json" ]]; then
  PREV_INSTANCE="$(cat "${RES_DIR}/instance.json")"
fi

rm -rf "${OUT_APP}"
mkdir -p "${MACOS_DIR}" "${RES_DIR}"

echo "==> Building vega-local (${VERSION}, darwin/${GOARCH_TARGET}, CGO_ENABLED=1)..."
(
  cd "${ROOT_DIR}/local"
  GOTOOLCHAIN=local CGO_ENABLED=1 GOOS=darwin GOARCH="${GOARCH_TARGET}" \
    go build -trimpath -ldflags="-s -w" -o "${MACOS_DIR}/vega-local" .
)

# Generate .icns icon from local/icon-connected.ico if sips + iconutil are available.
ICON_KEY=""
if command -v sips >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1 && [[ -f "${ROOT_DIR}/local/icon-connected.ico" ]]; then
  TMP_ICONSET="$(mktemp -d /tmp/vega-iconset.XXXXXX)/Vega.iconset"
  mkdir -p "${TMP_ICONSET}"
  if sips -s format png "${ROOT_DIR}/local/icon-connected.ico" --out "${TMP_ICONSET}/base.png" >/dev/null 2>&1; then
    for sz in 16 32 64 128 256 512; do
      sips -z "${sz}" "${sz}" "${TMP_ICONSET}/base.png" --out "${TMP_ICONSET}/icon_${sz}x${sz}.png" >/dev/null 2>&1 || true
      sz2=$((sz * 2))
      if [[ "${sz2}" -le 1024 ]]; then
        sips -z "${sz2}" "${sz2}" "${TMP_ICONSET}/base.png" --out "${TMP_ICONSET}/icon_${sz}x${sz}@2x.png" >/dev/null 2>&1 || true
      fi
    done
    rm -f "${TMP_ICONSET}/base.png"
    if iconutil -c icns "${TMP_ICONSET}" -o "${RES_DIR}/icon.icns" >/dev/null 2>&1; then
      ICON_KEY="  <key>CFBundleIconFile</key>
  <string>icon.icns</string>"
    fi
  fi
  rm -rf "$(dirname "${TMP_ICONSET}")"
fi

cat > "${CONTENTS_DIR}/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>com.vega.local</string>
  <key>CFBundleName</key>
  <string>牵牛星</string>
  <key>CFBundleDisplayName</key>
  <string>牵牛星</string>
  <key>CFBundleExecutable</key>
  <string>vega-local</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${VERSION}</string>
  <key>CFBundleVersion</key>
  <string>${VERSION}</string>
${ICON_KEY}
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>LSUIElement</key>
  <true/>
  <key>NSAccessibilityUsageDescription</key>
  <string>Vega 需要辅助功能权限以协助您读取桌面窗口控件并执行桌面自动化操作。</string>
  <key>NSScreenCaptureUsageDescription</key>
  <string>Vega 需要屏幕录制权限以在桌面任务中观察屏幕画面。</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsArbitraryLoads</key>
    <true/>
  </dict>
</dict>
</plist>
EOF

if [[ -n "${SITE_ORIGIN}" ]]; then
  cat > "${RES_DIR}/instance.json" <<EOF
{
  "origin": "${SITE_ORIGIN}"
}
EOF
  echo "==> Wrote ${RES_DIR}/instance.json (${SITE_ORIGIN})"
elif [[ -n "${PREV_INSTANCE}" ]]; then
  printf '%s\n' "${PREV_INSTANCE}" > "${RES_DIR}/instance.json"
  echo "==> Preserved existing ${RES_DIR}/instance.json"
fi

SIGN_ID="${VEGA_CODESIGN_IDENTITY:-}"
if [[ -z "${SIGN_ID}" ]]; then
  if security find-identity -v -p codesigning 2>/dev/null | grep -Fq '"Vega Local Dev"'; then
    SIGN_ID="Vega Local Dev"
  else
    SIGN_ID="-"
  fi
fi

echo "==> Signing ${OUT_APP} with identity: ${SIGN_ID}"
codesign --force --deep -s "${SIGN_ID}" "${OUT_APP}"

if [[ "${SIGN_ID}" == "-" ]]; then
  echo ""
  echo "提示：当前使用临时 ad-hoc 签名 (-)，重新编译后 macOS 可能会再次询问权限或钥匙串授权。"
  echo "如需一劳永逸免重复弹窗，请在「钥匙串访问 -> 证书助理 -> 创建证书」中新建名为"
  echo "  \"Vega Local Dev\"（证书类型选「代码签名」）的本地证书，之后重新运行本脚本将自动选用。"
fi

echo "==> Done: ${OUT_APP}"
