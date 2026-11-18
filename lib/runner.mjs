// Windows 执行器：参数固定，不接受网页传入 PowerShell 命令、路径或密钥。
// 每个任务复制完整上游包到用户临时目录，避免权限提升时访问插件缓存目录。
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LANGS = new Set(["zh-CN", "zh-TW", "zh-HK"]);
const TARGETS = new Set(["claude", "antigravity"]);
const MAX_LIVE_OUTPUT = 64000;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(command, args, options = {}) {
  const { onOutput, ...spawnOptions } = options;
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      windowsHide: true,
      shell: false,
      ...spawnOptions,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
        ...spawnOptions.env,
      },
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let output = "";
    const pushChunk = (data) => {
      output += data;
      onOutput?.(data);
    };
    child.stdout.on("data", pushChunk);
    child.stderr.on("data", pushChunk);
    child.on("error", (error) => resolveRun({ code: -1, output: error.message }));
    child.on("close", (code) => resolveRun({ code, output }));
  });
}

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

// 按 Windows CommandLineToArgvW 规范对 Start-Process -ArgumentList 参数加双引号，
// 正确转义反斜杠与闭合引号，避免以反斜杠结尾的路径吞掉闭合引号。
function quoteWinArg(value) {
  const s = String(value);
  if (s.length > 0 && !/[\s"]/.test(s)) return s;
  let out = '"';
  let backslashes = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") {
      backslashes++;
    } else if (ch === '"') {
      out += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
    } else {
      out += "\\".repeat(backslashes) + ch;
      backslashes = 0;
    }
  }
  out += "\\".repeat(backslashes * 2) + '"';
  return out;
}

function buildElevatedWrapperScript({ installer, isAntigravity, task, log }) {
  const lines = [
    "param([string]$OriginalUserSid = '', [switch]$AllowTakeOwnership)",
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()",
    `$env:CLAUDE_ZH_STAGE_LOG = ${psQuote(log)}`,
    "$env:CLAUDE_ZH_SKIP_UPDATE_CHECK = '1'",
    "$env:PYTHONUTF8 = '1'",
    "$env:PYTHONIOENCODING = 'utf-8'",
    "if ($OriginalUserSid) { $env:CLAUDE_ZH_ORIGINAL_USER_SID = $OriginalUserSid }",
  ];
  if (isAntigravity) {
    lines.push(
      "$scriptParams = @{",
      `    Action = ${psQuote(task.action)}`,
      `    Language = ${psQuote(task.language)}`,
      `    OriginalLocalAppData = ${psQuote(process.env.LOCALAPPDATA || "")}`,
      `    StageLogPath = ${psQuote(log)}`,
      "}",
      `& ${psQuote(installer)} @scriptParams`,
      "exit $LASTEXITCODE"
    );
  } else {
    lines.push(
      "$scriptParams = @{",
      `    Action = ${psQuote(task.action)}`,
      `    Language = ${psQuote(task.language)}`,
      "    OriginalUserSid = $OriginalUserSid",
      `    OriginalUserProfile = ${psQuote(process.env.USERPROFILE || "")}`,
      `    OriginalAppData = ${psQuote(process.env.APPDATA || "")}`,
      `    OriginalLocalAppData = ${psQuote(process.env.LOCALAPPDATA || "")}`,
      `    StageLogPath = ${psQuote(log)}`,
      "    SkipUpdateCheck = $true",
      "}",
      "if ($AllowTakeOwnership) { $scriptParams['AllowTakeOwnership'] = $true }",
      `& ${psQuote(installer)} @scriptParams`,
      "exit $LASTEXITCODE"
    );
  }
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}

export function createRunner({
  platform = process.platform,
  root = ROOT,
  stateDir = join(tmpdir(), "magpie-claude-desktop-zh-cn"),
  execute = run,
  sleep = wait,
  now = () => new Date().toISOString(),
} = {}) {
  let active = null;
  let lastResult = null;
  let detection = null;

  function snapshot() {
    return {
      platform,
      supported: platform === "win32",
      busy: Boolean(active),
      task: active ? {
        id: active.id,
        target: active.target,
        action: active.action,
        language: active.language,
        elevated: active.elevated,
        startedAt: active.startedAt,
        output: active.output.slice(-16000),
        elevatedNotice: active.elevated
          ? "Windows 可能已显示 UAC 提示。安装会在另一个 PowerShell 窗口执行；完成后请回到这里刷新。"
          : "",
      } : null,
      result: lastResult,
    };
  }

  async function detect() {
    detection ??= detectUncached().finally(() => { detection = null; });
    return detection;
  }

  async function detectUncached() {
    if (platform !== "win32") {
      return { installed: false, platform, message: "此插件只能修改运行它的 Windows 电脑上的 Claude Desktop。Linux 服务器版 Magpie 无法修改你的 Windows 客户端。" };
    }
    const script = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); $OutputEncoding=[System.Text.UTF8Encoding]::new(); $p = Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'Claude' -or $_.Name -eq 'AnthropicPBC.Claude' } | Select-Object -First 1; $claude = if ($p) { [pscustomobject]@{ installed=$true; kind='Microsoft Store / MSIX'; version=$p.Version.ToString(); path=$p.InstallLocation; packageFamilyName=$p.PackageFamilyName } } else { [pscustomobject]@{ installed=$false; message='未检测到 Microsoft Store 版；安装时也会检查官网安装版。' } }; $agDir = Join-Path $env:LOCALAPPDATA 'Programs\\antigravity'; $agExe = Join-Path $agDir 'Antigravity.exe'; $agRes = Join-Path $agDir 'resources'; $agAsar = Join-Path $agRes 'app.asar'; $agDis = Join-Path $agRes 'app.asar.disabled'; $agApp = Join-Path $agRes 'app'; $agInstalled = (Test-Path -LiteralPath $agExe) -or (Test-Path -LiteralPath $agAsar) -or (Test-Path -LiteralPath $agDis); $agPatched = (Test-Path -LiteralPath $agDis) -and (Test-Path -LiteralPath $agApp); $agVer = ''; if (Test-Path -LiteralPath $agExe) { try { $vi = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($agExe); $agVer = if ($vi.ProductVersion) { $vi.ProductVersion } else { $vi.FileVersion } } catch {} }; $ag = if ($agInstalled) { [pscustomobject]@{ installed=$true; patched=$agPatched; kind=(if ($agPatched) { '已汉化 (app 目录)' } else { '桌面安装版' }); version=$agVer; path=$agDir } } else { [pscustomobject]@{ installed=$false; patched=$false; message='未在默认用户目录检测到 Antigravity。' } }; [pscustomobject]@{ claude=$claude; antigravity=$ag } | ConvertTo-Json -Compress -Depth 4`;
    const result = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
    if (result.code !== 0) return { installed: false, error: result.output.slice(-1000) };
    try {
      const parsed = JSON.parse(result.output.trim());
      if (parsed && parsed.claude && parsed.antigravity) {
        return { platform, ...parsed.claude, targets: parsed };
      }
      return { platform, ...parsed };
    }
    catch { return { installed: false, error: "无法解析客户端安装信息。" }; }
  }

  function begin({ target = "claude", action, language, elevated = false, allowTakeOwnership = false }) {
    if (!TARGETS.has(target)) throw new Error("目标应用必须是 claude 或 antigravity。");
    if (!["install", "uninstall"].includes(action)) throw new Error("不支持的操作。");
    if (!LANGS.has(language)) throw new Error("语言必须是 zh-CN、zh-TW 或 zh-HK。");
    if (target === "antigravity" && language !== "zh-CN") throw new Error("Antigravity 当前仅支持简体中文（zh-CN）。");
    if (platform !== "win32") throw new Error("只能在 Windows 本机执行。");
    if (active) throw new Error("已有任务在执行，请等待完成。");
    if (action === "uninstall" && allowTakeOwnership) throw new Error("恢复时不能额外接管目录所有权。");
    if (target === "antigravity" && allowTakeOwnership) throw new Error("Antigravity 不需要接管 WindowsApps 目录所有权。");
    active = {
      id: randomUUID(), target, action, language, elevated, allowTakeOwnership,
      startedAt: now(), output: "",
    };
    // 立即开始准备；begin 返回 busy=true，测试和调用方都能等待 idle。
    const task = active;
    const done = perform(task).catch((error) => finish(task, { ok: false, error: error.message }));
    task.done = done;
    return snapshot();
  }

  function finish(task, result) {
    lastResult = {
      target: task.target,
      action: task.action,
      language: task.language,
      ...result,
      finishedAt: now(),
    };
    active = null;
    return lastResult;
  }

  async function pruneOldTaskPayloads(tasksRoot, currentTaskId) {
    const entries = await readdir(tasksRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === currentTaskId) continue;
      await rm(join(tasksRoot, entry.name, "payload"), { recursive: true, force: true }).catch(() => {});
    }
  }

  async function perform(task) {
    const tasksRoot = join(stateDir, "tasks");
    const base = join(tasksRoot, task.id);
    const stage = join(base, "payload");
    const log = join(base, "result.log");
    await mkdir(stage, { recursive: true });
    await pruneOldTaskPayloads(tasksRoot, task.id);
    const isAntigravity = task.target === "antigravity";
    if (isAntigravity) {
      await mkdir(join(stage, "scripts"), { recursive: true });
      await cp(join(root, "scripts", "install_antigravity_windows.ps1"), join(stage, "scripts", "install_antigravity_windows.ps1"));
      await cp(join(root, "resources", "antigravity"), join(stage, "resources", "antigravity"), { recursive: true });
    } else {
      await cp(join(root, "scripts"), join(stage, "scripts"), { recursive: true });
      await cp(join(root, "resources"), join(stage, "resources"), { recursive: true });
    }
    const installer = join(stage, "scripts", isAntigravity ? "install_antigravity_windows.ps1" : "install_windows.ps1");
    const args = isAntigravity
      ? [
          "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installer,
          task.action, task.language,
          "-OriginalLocalAppData", process.env.LOCALAPPDATA || "",
          "-StageLogPath", log,
        ]
      : [
          "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installer,
          task.action, task.language,
          "-OriginalUserProfile", process.env.USERPROFILE || "",
          "-OriginalAppData", process.env.APPDATA || "",
          "-OriginalLocalAppData", process.env.LOCALAPPDATA || "",
          "-StageLogPath", log,
          "-SkipUpdateCheck",
        ];
    if (!isAntigravity && task.allowTakeOwnership) args.push("-AllowTakeOwnership");
    const commonEnv = {
      ...process.env,
      CLAUDE_ZH_SKIP_UPDATE_CHECK: "1",
      CLAUDE_ZH_STAGE_LOG: log,
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
    };

    const appendLive = (chunk) => {
      if (!chunk || active !== task) return;
      task.output = (task.output + chunk).slice(-MAX_LIVE_OUTPUT);
    };

    if (!task.elevated) {
      const result = await execute("powershell.exe", args, { env: commonEnv, onOutput: appendLive });
      const output = result.output || "";
      await writeFile(log, output, "utf8");
      finish(task, { ok: result.code === 0, code: result.code, output: output.slice(-30000), log, elevated: false });
      return;
    }

    // 提权执行：生成 UTF-8 BOM 包装脚本以哈希表传参并设置环境变量，
    // 外层在原普通用户上下文中读取真实 SID 并转发，杜绝跨账户丢失 SID/环境变量及路径反斜杠转义问题。
    const wrapperPath = join(base, "elevated-wrapper.ps1");
    await writeFile(wrapperPath, buildElevatedWrapperScript({ installer, isAntigravity, task, log }), "utf8");

    const wrapperArgs = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", quoteWinArg(wrapperPath)];
    if (!isAntigravity && task.allowTakeOwnership) wrapperArgs.push("-AllowTakeOwnership");
    const psArgs = wrapperArgs.map(psQuote).join(",");
    const driver = `$ErrorActionPreference='Stop'; $sid = try { [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value } catch { '' }; $a=@(${psArgs}); if ($sid) { $a += @('-OriginalUserSid', $sid) }; $env:CLAUDE_ZH_STAGE_LOG=${psQuote(log)}; $p=Start-Process -FilePath 'powershell.exe' -ArgumentList $a -Verb RunAs -Wait -PassThru; exit $p.ExitCode`;

    let pumping = true;
    const pumpPromise = (async () => {
      while (pumping) {
        await sleep(500);
        if (!pumping || active !== task) break;
        const latest = await readFile(log, "utf8").catch(() => "");
        if (latest) task.output = latest.slice(-MAX_LIVE_OUTPUT);
      }
    })();

    let launch;
    try {
      launch = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", driver], { env: commonEnv });
    } finally {
      pumping = false;
      await pumpPromise.catch(() => {});
    }

    if (launch.code !== 0) {
      const partialLog = await readFile(log, "utf8").catch(() => "");
      const combinedOutput = partialLog || launch.output || "";
      finish(task, { ok: false, code: launch.code, output: combinedOutput.slice(-30000), error: "提权安装未完成。若你取消了 UAC，可重新点击安装。", log, elevated: true });
      return;
    }
    // 管理员窗口的输出不会自动回到插件。若安装器未写 stage 日志，读取它自己的 transcript。
    let output = "";
    for (let i = 0; i < 10 && !output; i++) {
      output = await readFile(log, "utf8").catch(() => readFile(join(stage, "scripts", "install-windows.log"), "utf8").catch(() => ""));
      if (!output) await sleep(500);
    }
    finish(task, { ok: true, code: launch.code, output: output.slice(-30000), log, elevated: true });
  }

  return { snapshot, detect, begin, stateDir, get active() { return active; } };
}
