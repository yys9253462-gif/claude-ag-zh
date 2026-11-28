#!/usr/bin/env python3
"""Antigravity macOS 简体中文补丁与无损恢复工具（仅使用 Python 标准库）。

核心能力：
1. 就地差量修补 Contents/Resources/app.asar，仅改写目标脚本并注入蜂群与全量斜杠命令翻译器，
   完整保留其余千余个文件、unpacked 原生扩展、executable 标记与原始数据块。
2. 若应用声明了 Info.plist 的 ElectronAsarIntegrity 与 Electron 37+ 摘要槽位，自动同步更新。
3. 首次修改前使用 ditto 完整备份官方 .app，并保留原应用 entitlements 执行本地临时重签名。
4. 支持一键从官方备份无损还原。
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import platform
import plistlib
import shutil
import struct
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any

# 同目录引入上游成熟的 macOS Electron 工具函数（不修改上游源码）
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import patch_claude_zh_cn as core  # noqa: E402

ASAR_INTEGRITY_BLOCK_SIZE = 4 * 1024 * 1024
STATE_FILE_REL = Path("Contents/Resources/.antigravity-zh-cn-state.json")
BACKUP_PREFIX = "Antigravity.backup-before-zh-CN-"
APP_ASAR_REL = Path("Contents/Resources/app.asar")
UNPACKED_APP_DIR_REL = Path("Contents/Resources/app")
DISABLED_ASAR_REL = Path("Contents/Resources/app.asar.disabled")

MARKER_DOM = "Antigravity Chinese Localization Engine"
MARKER_MENU = "Antigravity Chinese Localization Engine - Menu"
MARKER_SWARM = "Antigravity Chinese Localization Engine - Swarm"

REQUIRED_RESOURCE_FILES = (
    "dom-translator.js",
    "menu-translator.js",
    "swarm-translator.js",
    "swarm-redirects-hook.js",
)


def _ensure_utf8_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconf = getattr(stream, "reconfigure", None)
        if callable(reconf):
            try:
                reconf(encoding="utf-8", errors="replace")
            except Exception:
                pass


_ensure_utf8_stdio()


def log(msg: str) -> None:
    line = f"[antigravity-macos-zh] {msg}"
    try:
        print(line, flush=True)
    except UnicodeEncodeError:
        sys.stdout.buffer.write((line + "\n").encode("utf-8", errors="replace"))
        sys.stdout.flush()


def default_resources_dir() -> Path:
    return SCRIPT_DIR.parent / "resources" / "antigravity"


def verify_resources(res_dir: Path) -> None:
    missing = [name for name in REQUIRED_RESOURCE_FILES if not (res_dir / name).is_file()]
    if missing:
        raise SystemExit(f"缺少 Antigravity 汉化资源文件（目录：{res_dir}）：{', '.join(missing)}")


def find_antigravity_app(explicit: str | None = None) -> Path | None:
    if explicit:
        p = Path(explicit).expanduser().resolve()
        return p if (p / "Contents").is_dir() else None
    candidates = [
        Path("/Applications/Antigravity.app"),
        Path.home() / "Applications" / "Antigravity.app",
    ]
    for cand in candidates:
        if (cand / "Contents").is_dir():
            return cand
    return None


def read_app_version_info(app: Path) -> dict[str, str]:
    plist_path = app / "Contents" / "Info.plist"
    if not plist_path.is_file():
        return {"short": "", "build": "", "bundle_id": ""}
    with plist_path.open("rb") as fh:
        info = plistlib.load(fh)
    return {
        "short": str(info.get("CFBundleShortVersionString", "")),
        "build": str(info.get("CFBundleVersion", "")),
        "bundle_id": str(info.get("CFBundleIdentifier", "")),
    }


def list_backups(app: Path) -> list[Path]:
    parent = app.parent
    if not parent.is_dir():
        return []
    items = [
        p for p in parent.iterdir()
        if p.is_dir() and p.name.startswith(BACKUP_PREFIX) and p.name.endswith(".app")
    ]
    return sorted(items, key=lambda p: p.name, reverse=True)


def _compute_bytes_integrity(content: bytes) -> dict[str, Any]:
    blocks = [
        hashlib.sha256(content[off : off + ASAR_INTEGRITY_BLOCK_SIZE]).hexdigest()
        for off in range(0, len(content), ASAR_INTEGRITY_BLOCK_SIZE)
    ]
    if not blocks:
        blocks = [hashlib.sha256(b"").hexdigest()]
    return {
        "algorithm": "SHA256",
        "hash": hashlib.sha256(content).hexdigest(),
        "blockSize": ASAR_INTEGRITY_BLOCK_SIZE,
        "blocks": blocks,
    }


def _validate_relative_path(relative: str) -> list[str]:
    parts = relative.split("/")
    if not parts or any(part in ("", ".", "..") or "\\" in part for part in parts):
        raise SystemExit(f"ASAR 包含不安全路径：{relative}")
    return parts


def _validate_asar_header_paths(header: dict[str, Any]) -> None:
    for relative, _entry in core.walk_asar_entries(header):
        _validate_relative_path(relative)


def apply_idempotent_injection(existing: str, payload: str, marker: str) -> str:
    """幂等注入或热更新脚本尾部块，与 Windows 安装器行为严格一致。"""
    idx = existing.find("// " + marker)
    if idx < 0:
        idx = existing.find(marker)
    if idx >= 0:
        prefix = existing[:idx].rstrip()
        return prefix + "\n" + payload.strip() + "\n"
    return existing.rstrip() + "\n\n" + payload.strip() + "\n"


def apply_exact_replace(existing: str, target: str, replacement: str) -> str:
    if replacement in existing:
        return existing
    if target in existing:
        return existing.replace(target, replacement)
    return existing


def _insert_header_entry(header: dict[str, Any], relative: str, entry: dict[str, Any]) -> None:
    parts = _validate_relative_path(relative)
    node = header
    for part in parts[:-1]:
        files = node.setdefault("files", {})
        child = files.get(part)
        if not isinstance(child, dict) or "files" not in child:
            child = {"files": {}}
            files[part] = child
        node = child
    node.setdefault("files", {})[parts[-1]] = entry


def patch_asar_in_place(asar_path: Path, res_dir: Path) -> dict[str, Any]:
    """就地差量修补 app.asar，保留所有未改动文件的原始字节、unpacked、executable 与软链元数据。"""
    verify_resources(res_dir)
    data = asar_path.read_bytes()
    header_size, _header_str, orig_header = core.read_asar_header(data, asar_path)
    _validate_asar_header_paths(orig_header)
    data_start = 8 + header_size

    dom_js = (res_dir / "dom-translator.js").read_text(encoding="utf-8")
    menu_js = (res_dir / "menu-translator.js").read_text(encoding="utf-8")
    swarm_js = (res_dir / "swarm-translator.js").read_text(encoding="utf-8")
    swarm_hook_js = (res_dir / "swarm-redirects-hook.js").read_text(encoding="utf-8")

    def read_utf8_entry(rel: str) -> str | None:
        raw = core.read_asar_entry(data, header_size, orig_header, rel)
        return None if raw is None else raw.decode("utf-8")

    preload_src = read_utf8_entry("dist/preload.js")
    if preload_src is None:
        raise SystemExit(f"在 {asar_path} 中未找到 dist/preload.js，无法注入界面翻译器。")

    replacements: dict[str, bytes] = {}
    injected_targets: list[str] = []

    replacements["dist/preload.js"] = apply_idempotent_injection(
        preload_src, dom_js, MARKER_DOM
    ).encode("utf-8")
    injected_targets.append("dist/preload.js")

    menu_src = read_utf8_entry("dist/menu.js")
    if menu_src is not None:
        replacements["dist/menu.js"] = apply_idempotent_injection(
            menu_src, menu_js, MARKER_MENU
        ).encode("utf-8")
        injected_targets.append("dist/menu.js")

    redirects_src = read_utf8_entry("dist/redirects.js")
    if redirects_src is not None:
        replacements["dist/redirects.js"] = apply_idempotent_injection(
            redirects_src, swarm_hook_js, MARKER_SWARM
        ).encode("utf-8")
        replacements["dist/swarm-translator.js"] = swarm_js.encode("utf-8")
        injected_targets.extend(["dist/redirects.js", "dist/swarm-translator.js"])

    tray_src = read_utf8_entry("dist/tray.js")
    if tray_src is not None:
        tray_new = apply_exact_replace(tray_src, "'Show Antigravity'", "'显示 Antigravity'")
        tray_new = apply_exact_replace(tray_new, "'Quit'", "'退出'")
        if tray_new != tray_src:
            replacements["dist/tray.js"] = tray_new.encode("utf-8")
            injected_targets.append("dist/tray.js")

    loading_src = read_utf8_entry("dist/loadingOverlay.js")
    if loading_src is not None:
        loading_new = apply_exact_replace(loading_src, ">Loading Antigravity<", ">正在加载 Antigravity<")
        if loading_new != loading_src:
            replacements["dist/loadingOverlay.js"] = loading_new.encode("utf-8")
            injected_targets.append("dist/loadingOverlay.js")

    new_header = copy.deepcopy(orig_header)

    # 确保新增文件（如 dist/swarm-translator.js）已注册进目录树
    for rel in sorted(replacements):
        if core.asar_entry(new_header, rel) is None:
            _insert_header_entry(new_header, rel, {"size": len(replacements[rel])})

    # 顺序收集所有需要写入数据区的文件块，重新排布 offset；完全不动 unpacked 与 link 条目
    chunks: list[tuple[str, bytes | tuple[int, int]]] = []
    offset = 0

    def walk_rebuild(node: dict[str, Any], prefix: str = "") -> None:
        nonlocal offset
        files_map = node.get("files")
        if not isinstance(files_map, dict):
            return
        for name, entry in files_map.items():
            rel = f"{prefix}/{name}" if prefix else name
            if isinstance(entry, dict) and "files" in entry:
                walk_rebuild(entry, rel)
                continue
            if not isinstance(entry, dict):
                continue
            if entry.get("link") or entry.get("unpacked"):
                # 软链接与外部 unpacked 文件保持原样，零修改
                continue
            if rel in replacements:
                new_bytes = replacements[rel]
                entry["size"] = len(new_bytes)
                entry["offset"] = str(offset)
                entry["integrity"] = _compute_bytes_integrity(new_bytes)
                chunks.append((rel, new_bytes))
                offset += len(new_bytes)
            else:
                orig_entry = core.asar_entry(orig_header, rel)
                if orig_entry is None or "offset" not in orig_entry or "size" not in orig_entry:
                    raise SystemExit(f"ASAR 条目元数据不完整：{rel}")
                old_off = int(orig_entry["offset"])
                old_size = int(orig_entry["size"])
                if old_off < 0 or old_size < 0 or data_start + old_off + old_size > len(data):
                    raise SystemExit(f"ASAR 文件偏移越界：{rel}")
                entry["offset"] = str(offset)
                chunks.append((rel, (data_start + old_off, old_size)))
                offset += old_size

    walk_rebuild(new_header)

    header_string = json.dumps(new_header, separators=(",", ":"), ensure_ascii=False)
    header_bytes = header_string.encode("utf-8")
    payload_size = core.align4(4 + len(header_bytes))
    new_header_size = 4 + payload_size
    prefix_bytes = struct.pack("<II", 4, new_header_size)
    payload_bytes = (
        struct.pack("<II", payload_size, len(header_bytes))
        + header_bytes
        + b"\x00" * (payload_size - 4 - len(header_bytes))
    )

    tmp_path = asar_path.with_name(f"{asar_path.name}.tmp-{os.getpid()}")
    try:
        with tmp_path.open("wb") as out:
            out.write(prefix_bytes)
            out.write(payload_bytes)
            for _rel, item in chunks:
                if isinstance(item, bytes):
                    out.write(item)
                else:
                    start, length = item
                    out.write(data[start : start + length])
        os.replace(tmp_path, asar_path)
    finally:
        tmp_path.unlink(missing_ok=True)

    return {
        "injected": injected_targets,
        "header_sha256": core.asar_header_hash(header_string),
        "total_bytes": asar_path.stat().st_size,
    }


def quit_antigravity() -> None:
    if platform.system() != "Darwin":
        return
    log("正在请求退出 Antigravity...")
    subprocess.run(
        ["/usr/bin/osascript", "-e", 'tell application "Antigravity" to quit'],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    for _ in range(25):
        probe = subprocess.run(
            ["/usr/bin/pgrep", "-x", "Antigravity"],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if probe.returncode != 0:
            return
        time.sleep(0.2)
    subprocess.run(
        ["/usr/bin/pkill", "-9", "-x", "Antigravity"],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(0.5)


def copy_app_bundle(src: Path, dst: Path) -> None:
    if dst.exists():
        shutil.rmtree(dst)
    if platform.system() == "Darwin":
        core.copy_app(src, dst)
    else:
        shutil.copytree(src, dst, symlinks=True)


def swap_restore_from_backup(app: Path, backup: Path) -> None:
    """使用备份安全替换目标 .app（失败时自动回滚，避免应用丢失）。"""
    staged = app.parent / f".{app.name}.restore-tmp-{os.getpid()}"
    old_holder = app.parent / f".{app.name}.old-tmp-{os.getpid()}"
    try:
        copy_app_bundle(backup, staged)
        if old_holder.exists():
            shutil.rmtree(old_holder)
        os.replace(app, old_holder)
        try:
            os.replace(staged, app)
        except Exception:
            os.replace(old_holder, app)
            raise
        shutil.rmtree(old_holder, ignore_errors=True)
    finally:
        if staged.exists():
            shutil.rmtree(staged, ignore_errors=True)


def restore_antigravity(app: Path, *, skip_quit: bool = False) -> bool:
    backups = list_backups(app)
    if not backups:
        # 兼容极少数外部工具留下的 app.asar.disabled 方案
        disabled_asar = app / DISABLED_ASAR_REL
        unpacked_dir = app / UNPACKED_APP_DIR_REL
        if disabled_asar.is_file():
            if not skip_quit:
                quit_antigravity()
            os.replace(disabled_asar, app / APP_ASAR_REL)
            if unpacked_dir.is_dir():
                shutil.rmtree(unpacked_dir)
            (app / STATE_FILE_REL).unlink(missing_ok=True)
            log("已从 app.asar.disabled 恢复官方归档。")
            return True
        log("未找到 Antigravity 安装前备份，无需恢复。")
        return False

    if not skip_quit:
        quit_antigravity()

    latest = backups[0]
    log(f"正在从官方备份恢复：{latest.name}")
    swap_restore_from_backup(app, latest)
    for b in backups:
        shutil.rmtree(b, ignore_errors=True)
    log("已无损恢复 Antigravity 官方原版应用与官方签名。")
    return True


def install_antigravity(
    app: Path,
    res_dir: Path,
    *,
    skip_quit: bool = False,
    skip_codesign: bool = False,
) -> dict[str, Any]:
    verify_resources(res_dir)
    if not (app / "Contents").is_dir():
        raise SystemExit(f"无效的 macOS 应用包：{app}")

    if not skip_quit:
        quit_antigravity()

    # 若之前由外部工具遗留 app.asar.disabled + app/，先收拢为标准 app.asar 再处理
    asar_path = app / APP_ASAR_REL
    disabled_asar = app / DISABLED_ASAR_REL
    unpacked_dir = app / UNPACKED_APP_DIR_REL
    if not asar_path.is_file() and disabled_asar.is_file():
        log("检测到历史解包残留，正在恢复为标准 app.asar 后重新补丁...")
        os.replace(disabled_asar, asar_path)
        if unpacked_dir.is_dir():
            shutil.rmtree(unpacked_dir)

    if not asar_path.is_file():
        raise SystemExit(f"未在应用包内找到 {APP_ASAR_REL}：{app}")

    cur_ver = read_app_version_info(app)
    state_path = app / STATE_FILE_REL
    backups = list_backups(app)

    if state_path.is_file() and backups:
        latest_backup = backups[0]
        bak_ver = read_app_version_info(latest_backup)
        if bak_ver["short"] == cur_ver["short"] and bak_ver["build"] == cur_ver["build"]:
            log(f"检测到同版本已汉化应用（{cur_ver['short'] or '未知版本'}），先从官方备份还原干净基线再热更新...")
            swap_restore_from_backup(app, latest_backup)
        else:
            log("检测到官方应用已升级至新版本，正在为新版重新建立官方备份...")
            ts = datetime.now().strftime("%Y%m%d-%H%M%S")
            new_backup = app.parent / f"{BACKUP_PREFIX}{ts}.app"
            copy_app_bundle(app, new_backup)
            log(f"已创建新版官方备份：{new_backup.name}")
    elif not state_path.is_file():
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        new_backup = app.parent / f"{BACKUP_PREFIX}{ts}.app"
        log(f"正在创建官方原版完整备份：{new_backup.name}")
        copy_app_bundle(app, new_backup)
        # 清理较旧的历史备份，仅保留本次最新官方备份
        for old_bak in backups:
            shutil.rmtree(old_bak, ignore_errors=True)
        log("官方原版备份完成。")
    else:
        log("提示：应用已含补丁标记但未发现备份目录，将在当前归档上执行幂等热更新。")

    log("正在就地差量修补 app.asar（注入主界面 5543 词条、斜杠命令引擎、菜单及蜂群边车）...")
    patch_info = patch_asar_in_place(asar_path, res_dir)
    log(f"ASAR 修补完成：{', '.join(patch_info['injected'])}")

    integrity_updated = False
    if (app / "Contents" / "Info.plist").is_file():
        integrity_updated = core.update_electron_asar_integrity(app, "Resources/app.asar", asar_path)
        if integrity_updated:
            log("已同步刷新 Info.plist 中的 ElectronAsarIntegrity 与框架摘要槽位。")

    state_data = {
        "tool": "claude-ag-zh",
        "version": "0.5.0",
        "app_short_version": cur_ver["short"],
        "app_build_version": cur_ver["build"],
        "header_sha256": patch_info["header_sha256"],
        "injected": patch_info["injected"],
        "patched_at": datetime.now().isoformat(timespec="seconds"),
    }
    state_path.write_text(json.dumps(state_data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    if not skip_codesign and platform.system() == "Darwin":
        core.resign_app(app)
        core.clear_quarantine(app)
        log("已完成本地临时重签名（已保留原应用权限清单并兼容官方更新）。")

    log("Antigravity macOS 简体中文补丁安装完成！")
    return {
        **patch_info,
        "integrity_updated": integrity_updated,
        "app_version": cur_ver,
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Antigravity macOS 简体中文补丁与恢复工具")
    parser.add_argument("--app", help="Antigravity.app 路径（默认自动探测 /Applications 与 ~/Applications）")
    parser.add_argument("--resources-dir", help="Antigravity 汉化资源目录（默认脚本同级 ../resources/antigravity）")
    parser.add_argument("--check", action="store_true", help="仅校验内嵌资源完整性，不修改任何文件")
    parser.add_argument("--restore", action="store_true", help="从安装前备份无损恢复官方原版应用")
    parser.add_argument("--skip-quit", action="store_true", help="跳过自动退出应用（仅用于沙箱测试）")
    parser.add_argument("--skip-codesign", action="store_true", help="跳过 macOS codesign 重签名（仅用于非 Mac 沙箱测试）")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    res_dir = Path(args.resources_dir).resolve() if args.resources_dir else default_resources_dir()

    if args.check:
        verify_resources(res_dir)
        log("RESOURCE_CHECK_OK（仅校验内嵌资源，未修改任何应用）")
        return 0

    app = find_antigravity_app(args.app)
    if app is None:
        raise SystemExit("未找到 Antigravity.app。请先安装到 /Applications 或 ~/Applications，或通过 --app 指定路径。")

    if args.restore:
        restore_antigravity(app, skip_quit=args.skip_quit)
        return 0

    install_antigravity(
        app,
        res_dir,
        skip_quit=args.skip_quit,
        skip_codesign=args.skip_codesign,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
