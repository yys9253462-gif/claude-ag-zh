"""使用 Python 标准库构建未签名的 macOS 双端中文助手便携包（Claude Desktop + Antigravity）。

运行方式：python -I macos/package.py
此打包步骤仅依赖 Python 标准库，不会在构建机上调用 macOS 工具或触碰任何已安装应用。
"""
from __future__ import annotations

import hashlib
import plistlib
import stat
import struct
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VERSION = "0.5.0"
BUNDLE = "ClaudeDesktop-ZH-CN.app"
PREFIX = f"ClaudeDesktop-ZH-CN-macOS-{VERSION}"
FIXED_ZIP_TIME = (2026, 11, 29, 0, 0, 0)


def build_package(output_dir: Path | None = None) -> tuple[Path, str, int]:
    files: dict[str, tuple[bytes, int]] = {}

    def add(name: str, data: bytes, executable: bool = False) -> None:
        files[f"{PREFIX}/{name}"] = (data, 0o755 if executable else 0o644)

    contents = f"{BUNDLE}/Contents"
    payload = f"{contents}/Resources"
    info = {
        "CFBundleIdentifier": "io.github.yys9253462-gif.claude-desktop-zh-cn",
        "CFBundleName": "Claude & Antigravity 中文助手",
        "CFBundleDisplayName": "Claude & Antigravity 中文助手",
        "CFBundlePackageType": "APPL",
        "CFBundleExecutable": "ClaudeZhLauncher",
        "CFBundleShortVersionString": VERSION,
        "CFBundleVersion": VERSION,
        "CFBundleIconFile": "AppIcon.icns",
        "LSMinimumSystemVersion": "11.0",
        "NSHighResolutionCapable": True,
    }
    add(f"{contents}/Info.plist", plistlib.dumps(info))
    add(f"{contents}/PkgInfo", b"APPL????")
    add(
        f"{contents}/MacOS/ClaudeZhLauncher",
        b"""#!/bin/bash
set -euo pipefail
CONTENTS="$(cd "$(dirname "$0")/.." && pwd)"
exec /usr/bin/open -a Terminal "$CONTENTS/Resources/launch.command"
""",
        executable=True,
    )
    add(f"{payload}/launch.command", (ROOT / "macos/launch.command").read_bytes(), executable=True)
    add(f"{payload}/scripts/patch_claude_zh_cn.py", (ROOT / "scripts/patch_claude_zh_cn.py").read_bytes())
    add(f"{payload}/scripts/patch_antigravity_macos.py", (ROOT / "scripts/patch_antigravity_macos.py").read_bytes(), executable=True)
    add(f"{payload}/scripts/LICENSE", (ROOT / "scripts/LICENSE").read_bytes())

    # 打包 Claude Desktop 三语资源
    for path in sorted((ROOT / "resources").iterdir()):
        if path.is_file():
            add(f"{payload}/resources/{path.name}", path.read_bytes())

    # 打包 Antigravity 全部 v0.5.0 汉化资源（主界面、菜单、蜂群边车、斜杠命令与上游许可）
    ag_dir = ROOT / "resources" / "antigravity"
    for path in sorted(ag_dir.iterdir()):
        if path.is_file():
            add(f"{payload}/resources/antigravity/{path.name}", path.read_bytes())

    for name in ("LICENSE", "NOTICE.md", "UPSTREAM.lock.json"):
        add(name, (ROOT / name).read_bytes())
    add("使用说明.md", (ROOT / "macos/README.md").read_bytes())
    add(
        "打开中文助手.command",
        b"""#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
exec /bin/bash "$ROOT/ClaudeDesktop-ZH-CN.app/Contents/Resources/launch.command" "$@"
""",
        executable=True,
    )

    # 现代 macOS 原生支持 PNG 载荷的 ICNS 图标，无需 iconutil
    icon_parts = []
    for size, kind in ((128, b"ic07"), (256, b"ic08")):
        data = (ROOT / f"standalone/Assets/icon-{size}.png").read_bytes()
        icon_parts.append(kind + struct.pack(">I", len(data) + 8) + data)
    icon_body = b"".join(icon_parts)
    add(f"{payload}/AppIcon.icns", b"icns" + struct.pack(">I", len(icon_body) + 8) + icon_body)

    out_dir = output_dir or (ROOT / "artifacts/macos")
    out_dir.mkdir(parents=True, exist_ok=True)
    archive_path = out_dir / f"{PREFIX}.zip"
    with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, (data, mode) in sorted(files.items()):
            entry = zipfile.ZipInfo(name, date_time=FIXED_ZIP_TIME)
            entry.create_system = 3  # 保留 Unix 可执行权限位（0755/0644）
            entry.external_attr = (stat.S_IFREG | mode) << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(entry, data)

    # 完整性验证：校验 CRC、逐字节载荷、plist 与 Unix 执行权限位
    with zipfile.ZipFile(archive_path) as archive:
        if archive.testzip() is not None:
            raise RuntimeError("归档 CRC 校验失败")
        for name, (data, mode) in files.items():
            if archive.read(name) != data:
                raise RuntimeError(f"载荷字节不匹配: {name}")
            if (archive.getinfo(name).external_attr >> 16) & 0o777 != mode:
                raise RuntimeError(f"Unix 权限位不匹配: {name}")
        plist = plistlib.loads(archive.read(f"{PREFIX}/{contents}/Info.plist"))
        if plist["CFBundleExecutable"] != "ClaudeZhLauncher":
            raise RuntimeError("无效的应用包入口配置")
        if plist["CFBundleShortVersionString"] != VERSION:
            raise RuntimeError("应用包版本号不匹配")

    checksum = hashlib.sha256(archive_path.read_bytes()).hexdigest()
    archive_path.with_suffix(".zip.sha256").write_text(f"{checksum}  {archive_path.name}\n", encoding="ascii")
    return archive_path, checksum, len(files)


def main() -> None:
    archive_path, checksum, count = build_package()
    print(f"PACKAGE_OK: {archive_path}")
    print(f"FILES: {count}; BYTES: {archive_path.stat().st_size}")
    print(f"SHA256: {checksum}")
    print("未签名 macOS 便携包；尚待真实 Mac 实机验收签名与启动流程。")


if __name__ == "__main__":
    main()
