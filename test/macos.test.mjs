import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PYTHON = process.platform === "win32" ? "python" : "python3";

function runPython(code, extraArgs = []) {
  return spawnSync(PYTHON, ["-I", "-c", code, ...extraArgs], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

test("macOS Antigravity 补丁器：就地差量修补保留 unpacked/executable、刷新完整性槽位、幂等热更新与无损还原", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "ag-macos-patch-"));
  try {
    const pyScript = `
import hashlib, json, plistlib, struct, sys
from pathlib import Path

root = Path(sys.argv[1])
repo = Path(sys.argv[2])
sys.path.insert(0, str(repo / "scripts"))
import patch_claude_zh_cn as core
import patch_antigravity_macos as ag

def make_asar(out_path: Path, files_spec: dict, extra_meta: dict | None = None) -> tuple[str, bytes]:
    extra_meta = extra_meta or {}
    header = {"files": {}}
    chunks = []
    offset = 0
    for rel, content in files_spec.items():
        parts = rel.split("/")
        node = header
        for p in parts[:-1]:
            node = node.setdefault("files", {}).setdefault(p, {"files": {}})
        meta = dict(extra_meta.get(rel, {}))
        if meta.get("unpacked"):
            meta.setdefault("size", len(content))
            node.setdefault("files", {})[parts[-1]] = meta
        else:
            meta["size"] = len(content)
            meta["offset"] = str(offset)
            meta["integrity"] = ag._compute_bytes_integrity(content)
            node.setdefault("files", {})[parts[-1]] = meta
            chunks.append(content)
            offset += len(content)
    hstr = json.dumps(header, separators=(",", ":"), ensure_ascii=False)
    hbytes = hstr.encode("utf-8")
    psize = core.align4(4 + len(hbytes))
    hsize = 4 + psize
    blob = struct.pack("<II", 4, hsize) + struct.pack("<II", psize, len(hbytes)) + hbytes + b"\\x00" * (psize - 4 - len(hbytes)) + b"".join(chunks)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(blob)
    return core.asar_header_hash(hstr), blob

app = root / "Antigravity.app"
asar_path = app / "Contents/Resources/app.asar"
orig_files = {
    "dist/preload.js": b"console.log('preload');\\n",
    "dist/menu.js": b"const { Menu } = require('electron');\\n",
    "dist/redirects.js": b"exports.pluginResponse = function(r) { return r; };\\n",
    "dist/tray.js": b"const items = [{ label: 'Show Antigravity' }, { label: 'Quit' }];\\n",
    "dist/loadingOverlay.js": b"const html = '<div>Loading Antigravity</div>';\\n",
    "bin/tool.js": b"#!/usr/bin/env node\\nconsole.log('keep');\\n",
    "native/addon.node": b"NATIVE_UNPACKED_MARKER",
}
extra_meta = {
    "bin/tool.js": {"executable": True},
    "native/addon.node": {"unpacked": True},
}
orig_hash, orig_blob = make_asar(asar_path, orig_files, extra_meta)

# 构造同步包含 Info.plist ElectronAsarIntegrity 与 Electron 37+ 摘要槽位的假框架二进制
unpacked_file = app / "Contents/Resources/app.asar.unpacked/native/addon.node"
unpacked_file.parent.mkdir(parents=True, exist_ok=True)
unpacked_file.write_bytes(b"NATIVE_UNPACKED_REAL_BYTES")

integrity_dict = {"Resources/app.asar": {"algorithm": "SHA256", "hash": orig_hash}}
info_plist = app / "Contents/Info.plist"
info_plist.write_bytes(plistlib.dumps({
    "CFBundleIdentifier": "com.google.antigravity",
    "CFBundleShortVersionString": "2.35.1",
    "CFBundleVersion": "2351",
    "ElectronAsarIntegrity": integrity_dict,
}, fmt=plistlib.FMT_BINARY))

fw_path = app / core.ELECTRON_FRAMEWORK_REL
fw_path.parent.mkdir(parents=True, exist_ok=True)
orig_digest = core.compute_integrity_dictionary_digest(integrity_dict).encode("ascii")
fw_path.write_bytes(b"HEADER" + core.INTEGRITY_DIGEST_SENTINEL + b"10" + orig_digest + b"TRAILER")

res_dir = repo / "resources/antigravity"

# 1. 首次安装
res1 = ag.install_antigravity(app, res_dir, skip_quit=True, skip_codesign=True)
assert "dist/preload.js" in res1["injected"]
assert "dist/menu.js" in res1["injected"]
assert "dist/redirects.js" in res1["injected"]
assert "dist/swarm-translator.js" in res1["injected"]
assert "dist/tray.js" in res1["injected"]
assert "dist/loadingOverlay.js" in res1["injected"]
assert res1["integrity_updated"] is True

# 校验修补后的 ASAR：目标全注入、unpacked/executable 完整保留、原字节与外部文件原封不动
patched_data = asar_path.read_bytes()
hs, hstr, h = core.read_asar_header(patched_data, asar_path)
assert core.asar_header_hash(hstr) == res1["header_sha256"]
assert core.asar_entry(h, "bin/tool.js").get("executable") is True
assert core.asar_entry(h, "native/addon.node").get("unpacked") is True
assert unpacked_file.read_bytes() == b"NATIVE_UNPACKED_REAL_BYTES"
assert core.read_asar_entry(patched_data, hs, h, "bin/tool.js") == orig_files["bin/tool.js"]
preload_patched = core.read_asar_entry(patched_data, hs, h, "dist/preload.js").decode("utf-8")
redirects_patched = core.read_asar_entry(patched_data, hs, h, "dist/redirects.js").decode("utf-8")
swarm_in_asar = core.read_asar_entry(patched_data, hs, h, "dist/swarm-translator.js").decode("utf-8")
tray_patched = core.read_asar_entry(patched_data, hs, h, "dist/tray.js").decode("utf-8")
loading_patched = core.read_asar_entry(patched_data, hs, h, "dist/loadingOverlay.js").decode("utf-8")
assert "Antigravity Chinese Localization Engine" in preload_patched
assert "Antigravity Chinese Localization Engine - Swarm" in redirects_patched
assert "Antigravity Chinese Localization Engine - Swarm Board" in swarm_in_asar
assert "'显示 Antigravity'" in tray_patched and "'退出'" in tray_patched
assert ">正在加载 Antigravity<" in loading_patched

# 校验 Info.plist 与 Electron 37+ 槽位一致性（使用上游官方核验函数）
info_after = plistlib.loads(info_plist.read_bytes())
assert info_after["ElectronAsarIntegrity"]["Resources/app.asar"]["hash"] == res1["header_sha256"]
core.verify_integrity_digest_slot(app, info_after["ElectronAsarIntegrity"])

# 2. 同版本二次安装（幂等热更新，只保留 1 份官方备份且注入不重复）
res2 = ag.install_antigravity(app, res_dir, skip_quit=True, skip_codesign=True)
assert len(ag.list_backups(app)) == 1
patched_data2 = asar_path.read_bytes()
hs2, _hstr2, h2 = core.read_asar_header(patched_data2, asar_path)
preload2 = core.read_asar_entry(patched_data2, hs2, h2, "dist/preload.js").decode("utf-8")
redirects2 = core.read_asar_entry(patched_data2, hs2, h2, "dist/redirects.js").decode("utf-8")
assert preload2.count("// Antigravity Chinese Localization Engine") == 1
assert redirects2.count("// Antigravity Chinese Localization Engine - Swarm") == 1

# 3. 模拟官方恢复后校验逐字节还原回原始 ASAR 与 Info.plist
restored = ag.restore_antigravity(app, skip_quit=True)
assert restored is True
assert len(ag.list_backups(app)) == 0
assert asar_path.read_bytes() == orig_blob
info_restored = plistlib.loads(info_plist.read_bytes())
assert info_restored["ElectronAsarIntegrity"]["Resources/app.asar"]["hash"] == orig_hash
core.verify_integrity_digest_slot(app, info_restored["ElectronAsarIntegrity"])
print("MACOS_PATCH_E2E_OK")
`;
    const res = runPython(pyScript, [tempDir, REPO_ROOT]);
    assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /MACOS_PATCH_E2E_OK/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("macOS Antigravity 补丁器拦截恶意 ASAR 路径穿越条目", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "ag-macos-evil-"));
  try {
    const pyScript = `
import json, struct, sys
from pathlib import Path

root = Path(sys.argv[1])
repo = Path(sys.argv[2])
sys.path.insert(0, str(repo / "scripts"))
import patch_claude_zh_cn as core
import patch_antigravity_macos as ag

evil_asar = root / "evil.asar"
header = {"files": {"..": {"files": {"pwn.js": {"size": 4, "offset": "0"}}}}}
hbytes = json.dumps(header, separators=(",", ":")).encode("utf-8")
psize = core.align4(4 + len(hbytes))
hsize = 4 + psize
blob = struct.pack("<II", 4, hsize) + struct.pack("<II", psize, len(hbytes)) + hbytes + b"\\x00" * (psize - 4 - len(hbytes)) + b"evil"
evil_asar.write_bytes(blob)

try:
    ag.patch_asar_in_place(evil_asar, repo / "resources/antigravity")
except SystemExit as exc:
    assert "不安全路径" in str(exc), f"unexpected error: {exc}"
    print("EVIL_PATH_BLOCKED")
    raise SystemExit(0)
raise SystemExit("Expected SystemExit for path traversal!")
`;
    const res = runPython(pyScript, [tempDir, REPO_ROOT]);
    assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /EVIL_PATH_BLOCKED/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("macOS 0.5.0 双端打包器产物包含完整双端资源、Unix 执行权限且两次构建哈希完全可复现", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "ag-macos-pkg-"));
  try {
    const pyScript = `
import importlib.util, plistlib, sys, zipfile
from pathlib import Path

out_dir = Path(sys.argv[1])
repo = Path(sys.argv[2])
spec = importlib.util.spec_from_file_location("macos_pkg", repo / "macos/package.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

zip1, sha1, cnt1 = mod.build_package(out_dir)
zip2, sha2, cnt2 = mod.build_package(out_dir)
assert sha1 == sha2, f"Non-deterministic zip: {sha1} vs {sha2}"
assert cnt1 == cnt2

prefix = f"ClaudeDesktop-ZH-CN-macOS-{mod.VERSION}"
required_exec = [
    f"{prefix}/打开中文助手.command",
    f"{prefix}/ClaudeDesktop-ZH-CN.app/Contents/MacOS/ClaudeZhLauncher",
    f"{prefix}/ClaudeDesktop-ZH-CN.app/Contents/Resources/launch.command",
    f"{prefix}/ClaudeDesktop-ZH-CN.app/Contents/Resources/scripts/patch_antigravity_macos.py",
]
required_files = [
    f"{prefix}/ClaudeDesktop-ZH-CN.app/Contents/Resources/scripts/patch_claude_zh_cn.py",
    f"{prefix}/ClaudeDesktop-ZH-CN.app/Contents/Resources/resources/frontend-zh-CN.json",
    f"{prefix}/ClaudeDesktop-ZH-CN.app/Contents/Resources/resources/antigravity/dom-translator.js",
    f"{prefix}/ClaudeDesktop-ZH-CN.app/Contents/Resources/resources/antigravity/menu-translator.js",
    f"{prefix}/ClaudeDesktop-ZH-CN.app/Contents/Resources/resources/antigravity/swarm-translator.js",
    f"{prefix}/ClaudeDesktop-ZH-CN.app/Contents/Resources/resources/antigravity/swarm-redirects-hook.js",
]

with zipfile.ZipFile(zip1) as zf:
    names = set(zf.namelist())
    for p in required_exec:
        assert p in names, f"missing exec: {p}"
        mode = (zf.getinfo(p).external_attr >> 16) & 0o777
        assert mode == 0o755, f"expected 0755 for {p}, got {oct(mode)}"
    for p in required_files:
        assert p in names, f"missing file: {p}"
    # 校验包内 Shell 启动器保持纯 LF 无 CR
    launch_bytes = zf.read(f"{prefix}/ClaudeDesktop-ZH-CN.app/Contents/Resources/launch.command")
    assert b"\\r" not in launch_bytes, "launch.command must use LF line endings"
    plist = plistlib.loads(zf.read(f"{prefix}/ClaudeDesktop-ZH-CN.app/Contents/Info.plist"))
    assert plist["CFBundleShortVersionString"] == "0.5.0"

print(f"MACOS_PKG_OK sha={sha1} files={cnt1}")
`;
    const res = runPython(pyScript, [tempDir, REPO_ROOT]);
    assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /MACOS_PKG_OK/);

    // 确认仓库源码中的脚本均为纯 LF（无 CR）
    for (const rel of ["scripts/patch_antigravity_macos.py", "macos/launch.command", "macos/package.py"]) {
      const raw = await readFile(join(REPO_ROOT, rel));
      assert.equal(raw.includes(0x0d), false, `${rel} 不得包含 CR 回车符`);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("macOS 原生 DMG 构建脚本、真机验签脚本与云端工作流契约完整且纯 LF", async () => {
  const buildSh = await readFile(join(REPO_ROOT, "macos/build_dmg.sh"), "utf8");
  const verifyPy = await readFile(join(REPO_ROOT, "macos/verify_on_macos.py"), "utf8");
  const wf = await readFile(join(REPO_ROOT, ".github/workflows/macos-dmg.yml"), "utf8");
  const launchSh = await readFile(join(REPO_ROOT, "macos/launch.command"), "utf8");

  assert.match(buildSh, /hdiutil create/);
  assert.match(buildSh, /hdiutil verify/);
  assert.match(buildSh, /hdiutil attach/);
  assert.match(buildSh, /codesign --verify --deep --strict/);
  assert.match(verifyPy, /REAL_MACOS_CODESIGN_AND_RESTORE_OK/);
  assert.match(wf, /runs-on:\s*macos-latest/);
  assert.match(wf, /bash macos\/build_dmg\.sh/);
  assert.match(wf, /gh release upload/);
  assert.match(launchSh, /"\$PYTHON" -I -B -u /);

  for (const rel of ["macos/build_dmg.sh", "macos/verify_on_macos.py", ".github/workflows/macos-dmg.yml"]) {
    const raw = await readFile(join(REPO_ROOT, rel));
    assert.equal(raw.includes(0x0d), false, `${rel} 不得包含 CR 回车符`);
  }

  const pyChk = spawnSync(PYTHON, ["-m", "py_compile", join(REPO_ROOT, "macos/verify_on_macos.py")], { encoding: "utf8" });
  assert.equal(pyChk.status, 0, pyChk.stderr);
});
