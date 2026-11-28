#!/usr/bin/env python3
"""在真实 macOS 环境中对 patch_antigravity_macos.py 做真机签名与备份恢复端到端验证。

构造带真实 Mach-O 主可执行文件、标准 Electron Framework 动态库（含 Electron 37+ 摘要槽位）
与 ElectronAsarIntegrity 的沙箱 Antigravity.app，完整实跑 ditto 备份、ASAR 就地差量修补、
完整性同步、codesign 临时重签名（含 strict 验签）与无损恢复。
"""
from __future__ import annotations

import json
import os
import platform
import plistlib
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import patch_claude_zh_cn as core  # noqa: E402
import patch_antigravity_macos as ag  # noqa: E402


def build_mini_asar(out_path: Path, files_spec: dict[str, bytes]) -> tuple[str, bytes]:
    header: dict = {"files": {}}
    chunks: list[bytes] = []
    offset = 0
    for rel, content in files_spec.items():
        parts = rel.split("/")
        node = header
        for part in parts[:-1]:
            node = node.setdefault("files", {}).setdefault(part, {"files": {}})
        node.setdefault("files", {})[parts[-1]] = {
            "size": len(content),
            "offset": str(offset),
            "integrity": ag._compute_bytes_integrity(content),
        }
        chunks.append(content)
        offset += len(content)
    hstr = json.dumps(header, separators=(",", ":"), ensure_ascii=False)
    hbytes = hstr.encode("utf-8")
    psize = core.align4(4 + len(hbytes))
    hsize = 4 + psize
    blob = (
        struct.pack("<II", 4, hsize)
        + struct.pack("<II", psize, len(hbytes))
        + hbytes
        + b"\x00" * (psize - 4 - len(hbytes))
        + b"".join(chunks)
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(blob)
    return core.asar_header_hash(hstr), blob


def build_mock_electron_framework(app: Path, td_path: Path, initial_digest: str) -> None:
    """构造符合苹果 bundle 规范的 Electron Framework.framework（真 Mach-O 动态库 + 内嵌摘要槽位）。"""
    fw_bundle = app / "Contents/Frameworks/Electron Framework.framework"
    ver_a = fw_bundle / "Versions/A"
    res_dir = ver_a / "Resources"
    res_dir.mkdir(parents=True, exist_ok=True)

    sentinel_ascii = core.INTEGRITY_DIGEST_SENTINEL.decode("ascii")
    slot_literal = f"{sentinel_ascii}10{initial_digest}"
    fw_c = td_path / "electron_fw.c"
    fw_c.write_text(
        f'__attribute__((used)) const char ELECTRON_SLOT[] = "{slot_literal}";\n'
        'int electron_fw_anchor(void) { return (int)ELECTRON_SLOT[0]; }\n',
        encoding="ascii",
    )
    fw_bin = ver_a / "Electron Framework"
    subprocess.run(
        [
            "/usr/bin/clang",
            "-dynamiclib",
            "-install_name",
            "@rpath/Electron Framework.framework/Versions/A/Electron Framework",
            str(fw_c),
            "-o",
            str(fw_bin),
        ],
        check=True,
    )

    (res_dir / "Info.plist").write_bytes(
        plistlib.dumps(
            {
                "CFBundleIdentifier": "com.github.Electron.framework",
                "CFBundleName": "Electron Framework",
                "CFBundleExecutable": "Electron Framework",
                "CFBundlePackageType": "FMWK",
                "CFBundleShortVersionString": "37.0.0",
                "CFBundleVersion": "37.0.0",
            },
            fmt=plistlib.FMT_BINARY,
        )
    )

    # 标准 macOS Versioned Framework 软链接布局
    os.symlink("A", fw_bundle / "Versions/Current")
    os.symlink("Versions/Current/Electron Framework", fw_bundle / "Electron Framework")
    os.symlink("Versions/Current/Resources", fw_bundle / "Resources")


def main() -> int:
    if platform.system() != "Darwin":
        raise SystemExit("verify_on_macos.py 必须在 macOS 环境下运行。")

    with tempfile.TemporaryDirectory(prefix="ag-real-macos-verify.") as td:
        td_path = Path(td)
        app = td_path / "Antigravity.app"
        macos_dir = app / "Contents" / "MacOS"
        macos_dir.mkdir(parents=True, exist_ok=True)

        # 使用 clang 编译最小原生 Mach-O 可执行文件，使 codesign 执行真实 Mach-O 重签名路径
        c_src = td_path / "main.c"
        c_src.write_text("int main(void) { return 0; }\n", encoding="ascii")
        exe_out = macos_dir / "Antigravity"
        subprocess.run(["/usr/bin/clang", str(c_src), "-o", str(exe_out)], check=True)

        asar_path = app / "Contents/Resources/app.asar"
        orig_hash, orig_blob = build_mini_asar(
            asar_path,
            {
                "dist/preload.js": b"console.log('preload');\n",
                "dist/menu.js": b"const { Menu } = require('electron');\n",
                "dist/redirects.js": b"exports.pluginResponse = function(r) { return r; };\n",
                "dist/tray.js": b"const items = [{ label: 'Show Antigravity' }, { label: 'Quit' }];\n",
                "dist/loadingOverlay.js": b"const html = '<div>Loading Antigravity</div>';\n",
            },
        )

        integrity_dict = {"Resources/app.asar": {"algorithm": "SHA256", "hash": orig_hash}}
        info_plist = app / "Contents/Info.plist"
        info_plist.write_bytes(
            plistlib.dumps(
                {
                    "CFBundleIdentifier": "com.google.antigravity.sandbox",
                    "CFBundleName": "Antigravity",
                    "CFBundleExecutable": "Antigravity",
                    "CFBundlePackageType": "APPL",
                    "CFBundleShortVersionString": "2.35.1",
                    "CFBundleVersion": "2351",
                    "ElectronAsarIntegrity": integrity_dict,
                },
                fmt=plistlib.FMT_BINARY,
            )
        )

        # 构造符合苹果规范的真实 Mach-O Electron Framework（含 Electron 37+ 摘要槽位）
        orig_digest = core.compute_integrity_dictionary_digest(integrity_dict)
        build_mock_electron_framework(app, td_path, orig_digest)

        # 初始给沙箱应用签一个模拟“官方”基线签名（先签嵌套框架，再签外层应用）
        subprocess.run(
            [
                "/usr/bin/codesign",
                "--force",
                "--sign",
                "-",
                "--timestamp=none",
                str(app / "Contents/Frameworks/Electron Framework.framework/Versions/A"),
            ],
            check=True,
        )
        subprocess.run(
            ["/usr/bin/codesign", "--force", "--sign", "-", "--timestamp=none", str(app)],
            check=True,
        )

        # 1. 真机完整安装（启用 ditto 备份 + 真实 codesign 重签名，不跳过签名！）
        res = ag.install_antigravity(
            app,
            ROOT / "resources/antigravity",
            skip_quit=True,
            skip_codesign=False,
        )
        assert res["integrity_updated"] is True
        assert "dist/swarm-translator.js" in res["injected"]

        # 2. 苹果原生 codesign 严格验签 + 检查指定要求包含 identifier（确保不阻塞官方自动更新）
        subprocess.run(
            ["/usr/bin/codesign", "--verify", "--deep", "--strict", "--verbose=2", str(app)],
            check=True,
        )
        dr = subprocess.run(
            ["/usr/bin/codesign", "-d", "-r-", str(app)],
            check=True,
            capture_output=True,
            text=True,
        )
        dr_text = (dr.stdout or "") + (dr.stderr or "")
        assert 'identifier "com.google.antigravity.sandbox"' in dr_text, f"Unexpected DR: {dr_text}"

        # 3. 校验 ElectronAsarIntegrity 与框架摘要槽位同步一致
        info_after = plistlib.loads(info_plist.read_bytes())
        core.verify_integrity_digest_slot(app, info_after["ElectronAsarIntegrity"])

        # 4. 校验无损恢复回原始字节并再次通过 strict 验签
        assert ag.restore_antigravity(app, skip_quit=True) is True
        assert asar_path.read_bytes() == orig_blob
        subprocess.run(
            ["/usr/bin/codesign", "--verify", "--deep", "--strict", str(app)],
            check=True,
        )
        print("REAL_MACOS_CODESIGN_AND_RESTORE_OK")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
