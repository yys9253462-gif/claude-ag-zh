import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createApp } from "../lib/server.mjs";
import { createRunner } from "../lib/runner.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const readBytes = (rel) => readFile(join(repoRoot, rel));
const readUtf8 = (rel) => readFile(join(repoRoot, rel), "utf8");

function buildCustomAsar(headerTree, payloadChunks = []) {
  const headerJsonBuf = Buffer.from(JSON.stringify(headerTree), "utf8");
  const alignedHeaderLen = Math.ceil(headerJsonBuf.length / 4) * 4;
  const headerPadded = Buffer.alloc(alignedHeaderLen, 0);
  headerJsonBuf.copy(headerPadded);

  const headerBuf = Buffer.alloc(16);
  headerBuf.writeUInt32LE(4, 0);
  headerBuf.writeUInt32LE(8 + alignedHeaderLen, 4);
  headerBuf.writeUInt32LE(4 + alignedHeaderLen, 8);
  headerBuf.writeUInt32LE(headerJsonBuf.length, 12);

  return Buffer.concat([headerBuf, headerPadded, ...payloadChunks]);
}

test("服务端在带查询参数或 /index.html 访问时保持根基址，且遵守 HEAD 与跨源头隔离", async () => {
  const specialToken = "tok-$&-$$-safe";
  const app = createApp({
    token: specialToken,
    runner: {
      snapshot: () => ({ platform: "win32", supported: true, busy: false, task: null, result: null }),
      detect: async () => ({ installed: true, version: "1.0.0" }),
      begin: () => ({ busy: true }),
    },
  });
  const service = await app.listen(0);
  const baseUrl = `http://127.0.0.1:${service.port}`;
  try {
    for (const suffix of ["/?from=magpie&x=1", "/index.html", "/index.html?tab=ag"]) {
      const res = await fetch(`${baseUrl}${suffix}`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes(`content="${specialToken}"`), "特殊 $ 字符口令不得被正则替换损坏");
      assert.ok(html.includes(`content="${baseUrl}/"`), `访问 ${suffix} 时基址必须归一化为根路径`);
    }

    // HEAD 请求只返回头，不返回响应体
    const headRes = await fetch(`${baseUrl}/app.js`, { method: "HEAD" });
    assert.equal(headRes.status, 200);
    assert.ok(Number(headRes.headers.get("content-length")) > 100);
    assert.equal((await headRes.text()).length, 0, "HEAD 响应体必须为空");

    // 跨源被拒时绝不回显攻击者 Origin 或通配符 *
    const evilRes = await fetch(`${baseUrl}/api/state`, {
      headers: {
        "x-claude-zh-token": specialToken,
        origin: "https://evil.example",
      },
    });
    assert.equal(evilRes.status, 403);
    assert.equal(evilRes.headers.get("access-control-allow-origin"), null, "拒绝跨源时不得返回 ACAO 响应头");

    // 同源请求正确回显自身 Origin
    const ownRes = await fetch(`${baseUrl}/api/state`, {
      headers: {
        "x-claude-zh-token": specialToken,
        origin: baseUrl,
      },
    });
    assert.equal(ownRes.status, 200);
    assert.equal(ownRes.headers.get("access-control-allow-origin"), baseUrl);
  } finally {
    await service.close();
  }
});

test("Magpie 入口在端口首次占用失败后可自愈重试并支持端口切换", async () => {
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const blockedPort = blocker.address().port;

  // 动态加载带独立模块状态的入口逻辑副本进行验证
  const modUrl = new URL(`../index.mjs?case=${Date.now()}`, import.meta.url);
  const plugin = (await import(modUrl.href)).default;

  // 1. 端口被占时首次启动优雅兜底返回 {}，但不锁死后续重试
  await plugin.server({}, { port: blockedPort });
  await new Promise((resolve) => blocker.close(resolve));

  // 2. 端口释放后再次调用可自愈监听成功
  await plugin.server({}, { port: blockedPort });
  const okRes = await fetch(`http://127.0.0.1:${blockedPort}/`);
  assert.equal(okRes.status, 200);

  // 3. 切换新端口时关闭旧监听并迁移到新端口
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const nextPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  await plugin.server({}, { port: nextPort });
  const nextRes = await fetch(`http://127.0.0.1:${nextPort}/`);
  assert.equal(nextRes.status, 200);

  // 用越界回退或关闭：再切一次释放测试端口连接（进程结束前不挂住事件循环）
  await assert.rejects(() => fetch(`http://127.0.0.1:${blockedPort}/`));
  // 触发关闭 nextPort：通过临时占用 3485 使其切换失败从而关闭旧服务并释放句柄
  const dummy = createServer();
  await new Promise((resolve) => dummy.listen(0, "127.0.0.1", resolve));
  const dummyPort = dummy.address().port;
  await plugin.server({}, { port: dummyPort });
  await new Promise((resolve) => dummy.close(resolve));
});

test("执行器实时回传流式输出、安全生成提权包装脚本并自动回收旧任务载荷", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "claude-zh-audit-runner-"));
  try {
    let releaseFirst;
    let firstSnapDuringRun = null;
    const executed = [];

    const runner = createRunner({
      platform: "win32",
      stateDir,
      sleep: async () => {},
      execute: async (cmd, args, options) => {
        executed.push({ cmd, args, options });
        if (executed.length === 1) {
          options.onOutput?.("正在写入第 1 步...\n");
          firstSnapDuringRun = runner.snapshot();
          await new Promise((r) => { releaseFirst = r; });
          options.onOutput?.("完成。\n");
          return { code: 0, output: "正在写入第 1 步...\n完成。\n" };
        }
        // 第 2 次：提权任务
        await writeFile(options.env.CLAUDE_ZH_STAGE_LOG, "提权执行完毕", "utf8");
        return { code: 0, output: "" };
      },
    });

    const initial = runner.begin({ target: "antigravity", action: "install", language: "zh-CN" });
    const firstTaskId = initial.task.id;
    while (!releaseFirst) await new Promise((r) => setTimeout(r, 10));
    assert.match(firstSnapDuringRun.task.output, /正在写入第 1 步/, "运行期间 snapshot 应实时反映流式日志");
    releaseFirst();
    await runner.active.done;

    const firstRes = runner.snapshot().result;
    assert.equal(firstRes.ok, true);
    assert.equal(firstRes.target, "antigravity");
    assert.equal(firstRes.action, "install");
    assert.equal(firstRes.language, "zh-CN");

    // 启动第 2 次（提权）任务，验证旧任务的 payload 目录被自动清理，而新任务生成带 BOM 的包装脚本
    const second = runner.begin({ target: "claude", action: "install", language: "zh-CN", elevated: true, allowTakeOwnership: true });
    const secondTaskId = second.task.id;
    await runner.active.done;

    await assert.rejects(
      () => stat(join(stateDir, "tasks", firstTaskId, "payload")),
      "新任务启动后应自动清理历史任务的临时 payload 副本"
    );
    assert.ok((await stat(join(stateDir, "tasks", firstTaskId, "result.log"))).isFile(), "历史任务日志仍保留供排查");

    const wrapperBytes = await readFile(join(stateDir, "tasks", secondTaskId, "elevated-wrapper.ps1"));
    assert.equal(wrapperBytes[0], 0xef);
    assert.equal(wrapperBytes[1], 0xbb);
    assert.equal(wrapperBytes[2], 0xbf);
    const wrapperText = wrapperBytes.toString("utf8");
    assert.match(wrapperText, /OriginalUserSid/);
    assert.match(wrapperText, /@scriptParams/);
    assert.match(executed[1].args.at(-1), /WindowsIdentity/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("Antigravity 安装器拦截恶意 ASAR 路径越界并支持 unpacked 外部文件", { skip: process.platform !== "win32" }, async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "ag-asar-sec-"));
  const agScript = join(repoRoot, "scripts", "install_antigravity_windows.ps1");
  try {
    // 1. 构造含 ../escape.txt 的路径遍历恶意 ASAR，必须拒绝且不写出界外文件
    const badAppDir = join(tempRoot, "bad-app");
    const badResDir = join(badAppDir, "resources");
    await mkdir(badResDir, { recursive: true });
    const evilPayload = Buffer.from("pwned", "utf8");
    const evilAsar = buildCustomAsar(
      { files: { "..": { files: { "escape.txt": { size: evilPayload.length, offset: "0" } } } } },
      [evilPayload]
    );
    await writeFile(join(badResDir, "app.asar"), evilAsar);

    const badRes = spawnSync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", agScript,
      "install", "zh-CN", "-AppDirOverride", badAppDir, "-SkipLaunch", "-SkipProcessStop"
    ], { encoding: "utf8" });
    assert.notEqual(badRes.status, 0, "恶意路径越界 ASAR 必须返回非零退出码");
    await assert.rejects(() => stat(join(badResDir, "escape.txt")), "不得在目标目录外写入越界文件");
    await assert.rejects(() => stat(join(badResDir, "app")), "解包失败后不应残留半残的 resources/app 目录");

    // 2. 构造含 unpacked: true 的合法 ASAR，必须连同 app.asar.unpacked 文件一起解出
    const goodAppDir = join(tempRoot, "good-app");
    const goodResDir = join(goodAppDir, "resources");
    const unpackedSrcDir = join(goodResDir, "app.asar.unpacked", "dist");
    await mkdir(unpackedSrcDir, { recursive: true });
    await writeFile(join(unpackedSrcDir, "native.node"), "BINARY_NODE_PAYLOAD", "utf8");

    const preloadBuf = Buffer.from("console.log('ok');\n", "utf8");
    const goodAsar = buildCustomAsar(
      {
        files: {
          dist: {
            files: {
              "preload.js": { size: preloadBuf.length, offset: "0" },
              "native.node": { size: 19, unpacked: true },
            },
          },
        },
      },
      [preloadBuf]
    );
    await writeFile(join(goodResDir, "app.asar"), goodAsar);

    const goodRes = spawnSync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", agScript,
      "install", "zh-CN", "-AppDirOverride", goodAppDir, "-SkipLaunch", "-SkipProcessStop"
    ], { encoding: "utf8" });
    assert.equal(goodRes.status, 0, goodRes.stdout + goodRes.stderr);
    const copiedNative = await readFile(join(goodResDir, "app", "dist", "native.node"), "utf8");
    assert.equal(copiedNative, "BINARY_NODE_PAYLOAD");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Claude 主安装器流式完整性标记查找跨 1MB 分块准确且互斥锁冲突返回非零", { skip: process.platform !== "win32" }, async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "claude-stream-mutex-"));
  const mainScript = join(repoRoot, "scripts", "install_windows.ps1");
  try {
    // 1. 提取 Find-ClaudeExeIntegrityHashOffset 函数在跨越 1MB 边界（1048576 字节）的模拟文件上实测
    const fakeExe = join(tempRoot, "Claude.exe");
    const marker = '{"file":"resources\\\\ion-dist.asar","alg":"SHA256","value":"';
    const fakeHash = "a".repeat(64);
    const boundaryPos = 1048576 - 15; // 故意横跨第一个 1MB 读取块末尾与第二个块开头
    const buf = Buffer.alloc(boundaryPos + marker.length + 64 + 128, 0x20);
    buf.write(marker + fakeHash + '"}', boundaryPos, "ascii");
    await writeFile(fakeExe, buf);

    const psExtractAndTest = `
      $ast = [System.Management.Automation.Language.Parser]::ParseFile('${mainScript.replaceAll("'", "''")}', [ref]$null, [ref]$null)
      $fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Find-ClaudeExeIntegrityHashOffset' }, $true)
      Invoke-Expression $fn.Extent.Text
      $offset = Find-ClaudeExeIntegrityHashOffset -ExePath '${fakeExe.replaceAll("'", "''")}' -AsarName 'ion-dist.asar'
      Write-Output "OFFSET=$offset"
    `;
    const streamRes = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psExtractAndTest], { encoding: "utf8" });
    assert.equal(streamRes.status, 0, streamRes.stderr);
    assert.match(streamRes.stdout, new RegExp(`OFFSET=${boundaryPos + marker.length}\\b`), "跨 1MB 分块边界应精确返回哈希起始偏移");

    // 2. 验证互斥锁已被其他进程持有时，Install-WindowsLanguagePack 抛错返回非零而非静默 exit 0
    const mutexName = "Local\\ClaudeDesktopZhCn-Installer";
    const holder = spawn("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      `$m = New-Object System.Threading.Mutex($true, '${mutexName}'); [Console]::Out.WriteLine('LOCKED'); [Console]::Out.Flush(); Start-Sleep -Seconds 15`
    ], { stdio: ["ignore", "pipe", "pipe"] });

    try {
      await new Promise((resolve, reject) => {
        let out = "";
        holder.stdout.on("data", (d) => {
          out += d.toString();
          if (out.includes("LOCKED")) resolve();
        });
        holder.on("error", reject);
        setTimeout(() => reject(new Error("等待测试互斥锁超时")), 6000);
      });

      const directLockCheck = spawnSync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        `
        $ast = [System.Management.Automation.Language.Parser]::ParseFile('${mainScript.replaceAll("'", "''")}', [ref]$null, [ref]$null)
        foreach ($name in @('Get-LanguageLabel', 'Install-WindowsLanguagePack')) {
          $fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)
          Invoke-Expression $fn.Extent.Text
        }
        $LanguageCode = 'zh-CN'
        Install-WindowsLanguagePack
        `
      ], { encoding: "utf8" });
      assert.notEqual(directLockCheck.status, 0, "互斥锁被占用时必须抛错返回非零退出码，不得静默返回 0");
      assert.match(directLockCheck.stdout + directLockCheck.stderr, /另一个 Claude Desktop 中文补丁进程正在运行/);
    } finally {
      holder.kill();
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Antigravity 菜单与 DOM 翻译引擎具备空项防御、助记符支持与防双倍监听泄漏", async () => {
  // 1. 测试 menu-translator.js 空项安全与 &File 助记符翻译
  const menuCode = await readUtf8("resources/antigravity/menu-translator.js");
  let capturedTemplate = null;
  const fakeMenu = {
    buildFromTemplate(tpl) {
      capturedTemplate = tpl;
      return { items: tpl };
    },
  };
  vm.runInNewContext(menuCode, {
    require: (id) => (id === "electron" ? { Menu: fakeMenu } : {}),
    console,
  });
  const template = [
    null,
    undefined,
    { label: "&File", submenu: [null, { label: "New Window" }, { label: "E&xit" }] },
    { label: "Help", submenu: [{ label: "Toggle Developer Tools" }] },
  ];
  fakeMenu.buildFromTemplate(template);
  assert.equal(capturedTemplate[2].label, "文件 (&F)");
  assert.equal(capturedTemplate[2].submenu[1].label, "新建窗口");
  assert.equal(capturedTemplate[2].submenu[2].label, "退出 (&X)");
  assert.equal(capturedTemplate[3].label, "帮助");
  assert.equal(capturedTemplate[3].submenu[0].label, "切换开发者工具");

  // 2. 测试 dom-translator.js 在 loading 状态下只初始化一次，不产生双倍定时器与监听器泄漏
  const domCode = await readUtf8("resources/antigravity/dom-translator.js");
  let intervalCount = 0;
  let docListenerCount = 0;
  let treeWalkCount = 0;
  const winListeners = {};
  const timeouts = [];

  const docEl = { lang: "en", nodeType: 1, hasAttribute: () => false, getAttribute: () => null, firstChild: null };
  const fakeDoc = {
    readyState: "loading",
    documentElement: docEl,
    body: null,
    activeElement: null,
    nodeType: 9,
    addEventListener: () => { docListenerCount++; },
    removeEventListener: () => { docListenerCount--; },
    createTreeWalker: () => { treeWalkCount++; return { nextNode: () => null }; },
    querySelectorAll: () => [],
  };
  const sandbox = {
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_NODE: 9, DOCUMENT_FRAGMENT_NODE: 11 },
    NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1 },
    MutationObserver: class { observe() {} disconnect() {} },
    document: fakeDoc,
    console,
    Date,
    Array,
    Map,
    Set,
    RegExp,
    Object,
    String,
    Math,
    setInterval: () => { intervalCount++; return intervalCount; },
    clearInterval: () => { intervalCount--; },
    setTimeout: (fn) => { timeouts.push(fn); return timeouts.length; },
    clearTimeout: () => {},
    addEventListener: (ev, fn) => { winListeners[ev] = fn; },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(domCode, sandbox);

  // 触发 DOMContentLoaded 后，再手动触发 600ms 兜底回调，验证不会重复初始化
  winListeners.DOMContentLoaded?.();
  for (const fn of timeouts) fn();

  assert.equal(treeWalkCount, 1, "开屏初始化只允许执行 1 次全文档遍历");
  assert.equal(intervalCount, 1, "后台轮询定时器只允许存在 1 个实例");
  assert.equal(docListenerCount, 2, "pointerenter 与 contextmenu 监听器只允许注册 1 组（2 个）");
  assert.equal(docEl.lang, "zh-CN");

  // 验证右键菜单 Array.prototype.map 级联 submenu 翻译且不发生递归死循环
  const mapped = [{ accelerator: "Ctrl+C", label: "Copy", submenu: [{ label: "Paste" }] }].map((x) => x);
  assert.equal(mapped[0].label, "复制");
  assert.equal(mapped[0].submenu[0].label, "粘贴");
});

test("跨平台 Linux 与 macOS 脚本统一保持 LF 行尾，避免直接运行报换行符错误", async () => {
  for (const rel of ["scripts/install_linux.sh", "macos/launch.command", "macos/package.py", "macos/build_dmg.sh", "macos/verify_on_macos.py", "scripts/patch_linux_asar.py", "scripts/patch_antigravity_macos.py"]) {
    const raw = await readBytes(rel);
    assert.equal(raw.includes(0x0d), false, `${rel} 不得包含 CR (\\r) 字符`);
  }
});
