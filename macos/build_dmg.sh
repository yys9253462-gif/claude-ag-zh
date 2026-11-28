#!/bin/bash
# 在 macOS 上使用苹果原生 hdiutil 构建标准 .dmg 磁盘镜像与 .zip 便携包，并完成挂载自检。
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
    printf '%s\n' '[错误] macos/build_dmg.sh 必须在 macOS 环境中执行（依赖原生 hdiutil 与 codesign）。' >&2
    exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PYTHON_BIN="${PYTHON_BIN:-python3}"
VERSION="$("$PYTHON_BIN" -I -B -c "import importlib.util; s=importlib.util.spec_from_file_location('p','macos/package.py'); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(m.VERSION)")"
PREFIX="ClaudeDesktop-ZH-CN-macOS-${VERSION}"
OUT_DIR="$ROOT/artifacts/macos"
ZIP_PATH="$OUT_DIR/${PREFIX}.zip"
DMG_PATH="$OUT_DIR/${PREFIX}.dmg"
DMG_SHA_PATH="${DMG_PATH}.sha256"
VOL_NAME="Claude & Antigravity 中文助手 ${VERSION}"

printf '[1/5] 构建标准双端 ZIP 资源包（版本 %s）...\n' "$VERSION"
"$PYTHON_BIN" -I -B "$ROOT/macos/package.py"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/claude-ag-dmg.XXXXXX")"
STAGE_DIR="$WORK_DIR/stage"
MOUNT_DIR="$WORK_DIR/mount"
mkdir -p "$STAGE_DIR" "$MOUNT_DIR"

cleanup() {
    if mount | grep -F " on ${MOUNT_DIR} " >/dev/null 2>&1; then
        /usr/bin/hdiutil detach "$MOUNT_DIR" -force >/dev/null 2>&1 || true
    fi
    rm -rf "$WORK_DIR"
}
trap cleanup EXIT

printf '[2/5] 使用 ditto 保留权限与中文文件名解压载荷...\n'
/usr/bin/ditto -xk "$ZIP_PATH" "$WORK_DIR/unzipped"
cp -R "$WORK_DIR/unzipped/${PREFIX}/." "$STAGE_DIR/"
ln -s /Applications "$STAGE_DIR/Applications"

printf '[3/5] 为独立启动器执行本机临时代码签名并校验签名结构...\n'
/usr/bin/codesign --force --deep --sign - --timestamp=none "$STAGE_DIR/ClaudeDesktop-ZH-CN.app"
/usr/bin/codesign --verify --deep --strict --verbose=2 "$STAGE_DIR/ClaudeDesktop-ZH-CN.app"

printf '[4/5] 调用苹果原生 hdiutil 生成压缩只读 DMG 镜像...\n'
rm -f "$DMG_PATH" "$DMG_SHA_PATH"
/usr/bin/hdiutil create \
    -volname "$VOL_NAME" \
    -srcfolder "$STAGE_DIR" \
    -ov \
    -format UDZO \
    -imagekey zlib-level=9 \
    "$DMG_PATH"

DMG_SHA="$(/usr/bin/shasum -a 256 "$DMG_PATH" | awk '{print $1}')"
printf '%s  %s\n' "$DMG_SHA" "$(basename "$DMG_PATH")" > "$DMG_SHA_PATH"

printf '[5/5] 执行镜像完整性校验与真实只读挂载闭环验收...\n'
/usr/bin/hdiutil verify "$DMG_PATH"
/usr/bin/hdiutil attach "$DMG_PATH" -nobrowse -readonly -mountpoint "$MOUNT_DIR"

test -d "$MOUNT_DIR/ClaudeDesktop-ZH-CN.app"
test -L "$MOUNT_DIR/Applications"
test "$(readlink "$MOUNT_DIR/Applications")" = "/Applications"
test -x "$MOUNT_DIR/打开中文助手.command"
test -x "$MOUNT_DIR/ClaudeDesktop-ZH-CN.app/Contents/MacOS/ClaudeZhLauncher"
test -x "$MOUNT_DIR/ClaudeDesktop-ZH-CN.app/Contents/Resources/launch.command"
test -x "$MOUNT_DIR/ClaudeDesktop-ZH-CN.app/Contents/Resources/scripts/patch_antigravity_macos.py"

/bin/bash -n "$MOUNT_DIR/打开中文助手.command"
/bin/bash -n "$MOUNT_DIR/ClaudeDesktop-ZH-CN.app/Contents/MacOS/ClaudeZhLauncher"
/bin/bash -n "$MOUNT_DIR/ClaudeDesktop-ZH-CN.app/Contents/Resources/launch.command"
/usr/bin/codesign --verify --deep --strict "$MOUNT_DIR/ClaudeDesktop-ZH-CN.app"

CHECK_OUT="$(/bin/bash "$MOUNT_DIR/打开中文助手.command" --check)"
printf '%s\n' "$CHECK_OUT"
printf '%s\n' "$CHECK_OUT" | grep -F 'PACKAGE_CHECK_OK' >/dev/null

/usr/bin/hdiutil detach "$MOUNT_DIR"

DMG_BYTES="$(stat -f%z "$DMG_PATH")"
printf 'DMG_OK: %s\n' "$DMG_PATH"
printf 'DMG_BYTES: %s\n' "$DMG_BYTES"
printf 'DMG_SHA256: %s\n' "$DMG_SHA"
