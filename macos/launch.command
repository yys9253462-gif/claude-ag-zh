#!/bin/bash
# MIT；双端 macOS 中文助手启动器（支持 Antigravity 简体中文全面汉化 + Claude Desktop 三语汉化）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_PATCHER="$ROOT/scripts/patch_claude_zh_cn.py"
AG_PATCHER="$ROOT/scripts/patch_antigravity_macos.py"

# 只读资源自检模式：绝不修改或关闭本机任何应用。
if [ "${1:-}" = "--check" ]; then
    test -f "$CLAUDE_PATCHER"
    test -f "$AG_PATCHER"
    test -f "$ROOT/scripts/LICENSE"
    for lang in zh-CN zh-TW zh-HK; do
        test -f "$ROOT/resources/frontend-$lang.json"
        test -f "$ROOT/resources/frontend-hardcoded-$lang.json"
    done
    for agfile in dom-translator.js menu-translator.js swarm-translator.js swarm-redirects-hook.js LICENSE LICENSE-ZHUOLIN; do
        test -f "$ROOT/resources/antigravity/$agfile"
    done
    printf '%s\n' 'PACKAGE_CHECK_OK (dual-target resources verified; no installation performed)'
    exit 0
fi

if [ "$(uname -s)" != "Darwin" ]; then
    printf '%s\n' '此启动器只能在 macOS 上执行。未修改任何应用。' >&2
    exit 1
fi

# 仅使用系统/Homebrew 固定位置的 Python 3.10+，不执行下载目录中的未知可执行文件。
PYTHON=""
for candidate in /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
    if [ -x "$candidate" ] && "$candidate" -I -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1; then
        PYTHON="$candidate"
        break
    fi
done
if [ -z "$PYTHON" ]; then
    printf '%s\n' '需要 Python 3.10 或更新版本。请从 https://www.python.org/downloads/macos/ 安装后再打开本工具。'
    /usr/bin/osascript -e 'display dialog "需要 Python 3.10 或更新版本。请从 python.org 安装后重试。尚未关闭或修改任何应用。" with title "Claude & Antigravity 中文助手" buttons {"知道了"} default button "知道了"' >/dev/null || true
    exit 1
fi

/bin/bash "$0" --check

# 用户取消操作均在请求权限与关闭应用之前完成。
CHOICE="$(/usr/bin/osascript <<'APPLESCRIPT'
set selected to choose from list {"Antigravity · 简体中文（含蜂群与全部斜杠命令）", "Antigravity · 恢复官方原版（使用备份）", "Claude Desktop · 简体中文（zh-CN）", "Claude Desktop · 繁體中文（台灣 · zh-TW）", "Claude Desktop · 繁體中文（香港 · zh-HK）", "Claude Desktop · 恢复官方原版（使用备份）"} with title "Claude & Antigravity 中文助手 0.5.0" with prompt "请选择目标应用及操作，然后点击「下一步」。此时不会修改任何应用。" default items {"Antigravity · 简体中文（含蜂群与全部斜杠命令）"} OK button name "下一步" cancel button name "取消"
if selected is false then return "cancel"
return item 1 of selected
APPLESCRIPT
)" || exit 0

case "$CHOICE" in
    'Antigravity · 简体中文（含蜂群与全部斜杠命令）')
        TARGET=antigravity; ACTION=install; LANG_CODE=zh-CN ;;
    'Antigravity · 恢复官方原版（使用备份）')
        TARGET=antigravity; ACTION=restore; LANG_CODE=zh-CN ;;
    'Claude Desktop · 简体中文（zh-CN）')
        TARGET=claude; ACTION=install; LANG_CODE=zh-CN ;;
    'Claude Desktop · 繁體中文（台灣 · zh-TW）')
        TARGET=claude; ACTION=install; LANG_CODE=zh-TW ;;
    'Claude Desktop · 繁體中文（香港 · zh-HK）')
        TARGET=claude; ACTION=install; LANG_CODE=zh-HK ;;
    'Claude Desktop · 恢复官方原版（使用备份）')
        TARGET=claude; ACTION=restore; LANG_CODE=zh-CN ;;
    *) exit 0 ;;
esac

if [ "$TARGET" = "antigravity" ]; then
    APP_NAME="Antigravity"
    APP="/Applications/Antigravity.app"
    if [ ! -d "$APP/Contents" ]; then
        APP="$HOME/Applications/Antigravity.app"
    fi
    if [ ! -d "$APP/Contents" ]; then
        /usr/bin/osascript -e 'display dialog "未找到 Antigravity.app。请先将 Antigravity 安装到 /Applications 或用户 Applications 文件夹。" with title "Claude & Antigravity 中文助手" buttons {"知道了"} default button "知道了"' >/dev/null || true
        exit 1
    fi
    if [ "$ACTION" = "restore" ]; then
        backups=("$(dirname "$APP")"/Antigravity.backup-before-zh-CN-*.app)
        if [ ! -d "${backups[0]}" ] && [ ! -f "$APP/Contents/Resources/app.asar.disabled" ]; then
            /usr/bin/osascript -e 'display dialog "未找到 Antigravity 安装前备份，无需执行恢复。Antigravity 没有被关闭。" with title "Claude & Antigravity 中文助手" buttons {"知道了"} default button "知道了"' >/dev/null || true
            exit 0
        fi
    fi
else
    APP_NAME="Claude Desktop"
    APP="/Applications/Claude.app"
    if [ ! -d "$APP/Contents" ]; then
        APP="$HOME/Applications/Claude.app"
    fi
    if [ ! -d "$APP/Contents" ]; then
        /usr/bin/osascript -e 'display dialog "未找到 Claude.app。请先将 Claude 安装到 /Applications 或用户 Applications 文件夹。" with title "Claude & Antigravity 中文助手" buttons {"知道了"} default button "知道了"' >/dev/null || true
        exit 1
    fi
    if [ "$ACTION" = "restore" ]; then
        backups=("$(dirname "$APP")"/Claude.backup-before-zh-CN-*.app)
        if [ ! -d "${backups[0]}" ]; then
            /usr/bin/osascript -e 'display dialog "未找到 Claude 安装前备份，无需执行恢复。Claude 没有被关闭。" with title "Claude & Antigravity 中文助手" buttons {"知道了"} default button "知道了"' >/dev/null || true
            exit 0
        fi
    fi
fi

# 判断目标应用目录是否对当前用户可直接写入（~/Applications 等目录可免 sudo）
APP_DIR="$(dirname "$APP")"
NEED_SUDO=0
if [ ! -w "$APP" ] || [ ! -w "$APP_DIR" ]; then
    NEED_SUDO=1
fi
if [ "$TARGET" = "claude" ]; then
    # 上游 Claude 补丁涉及受管偏好目录时仍按上游方式使用 sudo
    NEED_SUDO=1
fi

CONFIRM_NOTE="即将关闭 ${APP_NAME} 并修改本机应用。请先保存正在进行的工作。\n\n安装会自动保留原应用完整备份，并使用本机临时签名重新签署修改后的应用。恢复会使用最近一次官方备份。\n\n本 macOS 包尚未在真实 Mac 上完成全链路验收。"
if [ "$NEED_SUDO" -eq 1 ]; then
    CONFIRM_NOTE="${CONFIRM_NOTE}确认继续后，请在终端输入这台 Mac 的登录密码（输入时不会显示字符）。"
fi

/usr/bin/osascript - "$CONFIRM_NOTE" <<'APPLESCRIPT' >/dev/null || exit 0
on run argv
    set msg to item 1 of argv
    display dialog msg with title "确认执行" buttons {"取消", "开始执行"} default button "取消" cancel button "取消" with icon caution
end run
APPLESCRIPT

LOG_DIR="$HOME/Library/Logs/ClaudeDesktop-ZH-CN"
mkdir -p "$LOG_DIR"
LOCK="$LOG_DIR/task.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
    printf '%s\n' "已有任务锁：$LOCK。请等待任务结束；异常退出后请先确认没有安装任务，再删除这个空目录。" >&2
    exit 1
fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

LOG="$LOG_DIR/task-${TARGET}-$(date +%Y%m%d-%H%M%S)-$$.log"
printf '目标：%s (%s)\n操作：%s %s\n日志：%s\n' "$APP_NAME" "$APP" "$ACTION" "$LANG_CODE" "$LOG"

if [ "$NEED_SUDO" -eq 1 ]; then
    printf '%s\n' "正在请求管理员权限；接下来可能关闭 ${APP_NAME}。"
    /usr/bin/sudo -v
fi

set +e
if [ "$TARGET" = "antigravity" ]; then
    AG_ARGS=(--app "$APP" --resources-dir "$ROOT/resources/antigravity")
    if [ "$ACTION" = "restore" ]; then
        AG_ARGS+=(--restore)
    fi
    if [ "$NEED_SUDO" -eq 1 ]; then
        /usr/bin/sudo "$PYTHON" -I -B -u "$AG_PATCHER" "${AG_ARGS[@]}" 2>&1 | /usr/bin/tee "$LOG"
        RESULT=${PIPESTATUS[0]}
    else
        "$PYTHON" -I -B -u "$AG_PATCHER" "${AG_ARGS[@]}" 2>&1 | /usr/bin/tee "$LOG"
        RESULT=${PIPESTATUS[0]}
    fi
else
    if [ "$ACTION" = "restore" ]; then
        /usr/bin/sudo "$PYTHON" -I -B -u "$CLAUDE_PATCHER" --app "$APP" --user-home "$HOME" --restore 2>&1 | /usr/bin/tee "$LOG"
        RESULT=${PIPESTATUS[0]}
    else
        /usr/bin/sudo "$PYTHON" -I -B -u "$CLAUDE_PATCHER" --app "$APP" --user-home "$HOME" --restore-if-backup-exists 2>&1 | /usr/bin/tee "$LOG"
        RESULT=${PIPESTATUS[0]}
        if [ "$RESULT" -eq 0 ]; then
            /usr/bin/sudo "$PYTHON" -I -B -u "$CLAUDE_PATCHER" --app "$APP" --user-home "$HOME" --lang "$LANG_CODE" 2>&1 | /usr/bin/tee -a "$LOG"
            RESULT=${PIPESTATUS[0]}
        fi
    fi
fi
set -e

if [ "$RESULT" -eq 0 ]; then
    /usr/bin/open "$APP" || true
    printf '\n执行完成。请在 %s 内检查中文界面与常用功能。\n' "$APP_NAME"
    /usr/bin/osascript - "$APP_NAME" <<'APPLESCRIPT' >/dev/null || true
on run argv
    set appLabel to item 1 of argv
    display dialog ("安装器已返回成功，已尝试重新打开 " & appLabel & "。请检查语言是否切换及常用页面是否正常。") with title "执行完成" buttons {"知道了"} default button "知道了"
end run
APPLESCRIPT
else
    printf '\n执行失败，退出码：%s\n日志：%s\n' "$RESULT" "$LOG" >&2
    /usr/bin/osascript - "$APP_NAME" <<'APPLESCRIPT' >/dev/null || true
on run argv
    set appLabel to item 1 of argv
    display dialog ("执行未完成，请查看终端日志；原应用备份由安装器保留。可重新打开本工具选择恢复 " & appLabel & " 官方原版。") with title "执行失败" buttons {"知道了"} default button "知道了" with icon caution
end run
APPLESCRIPT
fi

if [ -t 0 ]; then
    printf '%s' '按回车关闭此终端任务…'
    read -r _ || true
fi
exit "$RESULT"
