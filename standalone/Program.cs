using System.Diagnostics;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;

namespace ClaudeZhStandalone;

public sealed record InstallResult(int ExitCode, string Output, string LogPath, bool Elevated);

public static class Installer
{
    private static readonly object PayloadSync = new();
    private static string? cachedPayloadRoot;

    public static string PayloadRoot => EnsurePayload();

    /// <summary>
    /// 释放内嵌语言包。用包内容哈希做目录名并缓存路径，采用临时目录原子切换避免并发半残状态，
    /// 同时顺手清理旧版本残留缓存目录。
    /// </summary>
    private static string EnsurePayload()
    {
        lock (PayloadSync)
        {
            if (cachedPayloadRoot is not null && File.Exists(Path.Combine(cachedPayloadRoot, ".complete")))
            {
                return cachedPayloadRoot;
            }

            using var resource = typeof(Installer).Assembly.GetManifestResourceStream("ClaudeZhStandalone.payload.zip")
                ?? throw new FileNotFoundException("EXE 内嵌语言包缺失");

            using var buffer = new MemoryStream();
            resource.CopyTo(buffer);
            var bytes = buffer.ToArray();
            var hash = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant()[..16];

            var baseDir = Path.Combine(Path.GetTempPath(), "ClaudeDesktop-ZH-CN");
            Directory.CreateDirectory(baseDir);
            var root = Path.Combine(baseDir, "payload-" + hash);
            var marker = Path.Combine(root, ".complete");

            if (!File.Exists(marker))
            {
                var staging = Path.Combine(baseDir, $"payload-{hash}.tmp-{Guid.NewGuid():N}");
                try
                {
                    Directory.CreateDirectory(staging);
                    using (var archive = new ZipArchive(new MemoryStream(bytes), ZipArchiveMode.Read))
                    {
                        archive.ExtractToDirectory(staging, true);
                    }
                    File.WriteAllText(Path.Combine(staging, ".complete"), hash);

                    if (Directory.Exists(root) && !File.Exists(marker))
                    {
                        try { Directory.Delete(root, true); } catch { }
                    }
                    if (!Directory.Exists(root))
                    {
                        Directory.Move(staging, root);
                    }
                }
                finally
                {
                    try { if (Directory.Exists(staging)) Directory.Delete(staging, true); } catch { }
                }
            }

            // 清理过期版本的 payload-* 目录，避免长期升级堆积磁盘空间
            try
            {
                foreach (var dir in Directory.EnumerateDirectories(baseDir, "payload-*"))
                {
                    if (!string.Equals(Path.GetFullPath(dir), Path.GetFullPath(root), StringComparison.OrdinalIgnoreCase) &&
                        !dir.Contains(".tmp-", StringComparison.OrdinalIgnoreCase))
                    {
                        try { Directory.Delete(dir, true); } catch { }
                    }
                }
            }
            catch { }

            cachedPayloadRoot = root;
            return root;
        }
    }

    public static string DetectVersion()
    {
        try
        {
            using var localUninst = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\Uninstall\AnthropicClaude");
            var ver = localUninst?.GetValue("DisplayVersion")?.ToString();
            if (!string.IsNullOrWhiteSpace(ver)) return ver;

            using var key = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(
                @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Claude");
            return key?.GetValue("DisplayVersion")?.ToString() ?? "已安装（版本由安装器检测）";
        }
        catch { return "已安装（版本由安装器检测）"; }
    }

    public static string CurrentUserSid()
    {
        try
        {
            using var identity = WindowsIdentity.GetCurrent();
            return identity.User?.Value ?? "";
        }
        catch { return ""; }
    }

    /// <summary>
    /// 检测正在运行的 Claude Desktop 进程（不含 Claude Code 的 CLI 进程）。
    /// 确保释放 GetProcessesByName 返回的全部进程内核句柄。
    /// </summary>
    public static bool IsClaudeRunning()
    {
        try
        {
            var found = false;
            foreach (var process in Process.GetProcessesByName("claude"))
            {
                try
                {
                    if (found) continue;
                    var path = process.MainModule?.FileName;
                    if (string.IsNullOrEmpty(path)) continue;
                    if (!path.EndsWith("Claude.exe", StringComparison.OrdinalIgnoreCase)) continue;
                    if (path.Contains("WindowsApps", StringComparison.OrdinalIgnoreCase) ||
                        path.Contains("AnthropicClaude", StringComparison.OrdinalIgnoreCase))
                    {
                        found = true;
                    }
                }
                catch
                {
                    // 无权读取 MainModule 时跳过
                }
                finally
                {
                    process.Dispose();
                }
            }
            return found;
        }
        catch { return false; }
    }

    public static bool IsAntigravityRunning()
    {
        try
        {
            var processes = Process.GetProcessesByName("Antigravity");
            try
            {
                return processes.Length > 0;
            }
            finally
            {
                foreach (var p in processes) p.Dispose();
            }
        }
        catch { return false; }
    }

    public static (bool Installed, bool Patched, string Version) DetectAntigravity()
    {
        try
        {
            var localApp = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            var appDir = Path.Combine(localApp, "Programs", "antigravity");
            var exePath = Path.Combine(appDir, "Antigravity.exe");
            var resDir = Path.Combine(appDir, "resources");
            var asarPath = Path.Combine(resDir, "app.asar");
            var disabledPath = asarPath + ".disabled";
            var unpackedDir = Path.Combine(resDir, "app");

            var installed = File.Exists(exePath) || File.Exists(asarPath) || File.Exists(disabledPath);
            var patched = File.Exists(disabledPath) && Directory.Exists(unpackedDir);
            var version = "";
            if (File.Exists(exePath))
            {
                var info = FileVersionInfo.GetVersionInfo(exePath);
                version = info.ProductVersion ?? info.FileVersion ?? "";
            }
            return (installed, patched, version);
        }
        catch { return (false, false, ""); }
    }

    public static async Task<InstallResult> RunAsync(
        string action,
        string language,
        bool allowTakeOwnership,
        string workRoot,
        string scriptsPath,
        string resourcesPath,
        Action<string> log,
        CancellationToken cancellationToken = default,
        string target = "claude")
    {
        if (target is not ("claude" or "antigravity")) throw new ArgumentException("不支持的目标应用", nameof(target));
        if (action is not ("install" or "uninstall")) throw new ArgumentException("不支持的操作", nameof(action));
        if (language is not ("zh-CN" or "zh-TW" or "zh-HK")) throw new ArgumentException("不支持的语言", nameof(language));
        if (target == "antigravity" && language != "zh-CN") throw new ArgumentException("Antigravity 当前仅支持简体中文（zh-CN）", nameof(language));
        if (action == "uninstall" && allowTakeOwnership) throw new ArgumentException("恢复不接管目录所有权");
        if (target == "antigravity" && allowTakeOwnership) throw new ArgumentException("Antigravity 不需要接管目录所有权");

        var taskDir = Path.Combine(workRoot, Guid.NewGuid().ToString("N"));
        var payloadDir = Path.Combine(taskDir, "payload");
        Directory.CreateDirectory(payloadDir);
        try
        {
            if (target == "antigravity")
            {
                var dstScripts = Path.Combine(payloadDir, "scripts");
                Directory.CreateDirectory(dstScripts);
                File.Copy(
                    Path.Combine(scriptsPath, "install_antigravity_windows.ps1"),
                    Path.Combine(dstScripts, "install_antigravity_windows.ps1"),
                    true);
                CopyDirectory(
                    Path.Combine(resourcesPath, "antigravity"),
                    Path.Combine(payloadDir, "resources", "antigravity"));

                var agLogPath = Path.Combine(taskDir, "install.log");
                var agInstaller = Path.Combine(dstScripts, "install_antigravity_windows.ps1");
                return await RunAntigravityDirectAsync(agInstaller, action, language, agLogPath, log, cancellationToken);
            }

            CopyDirectory(scriptsPath, Path.Combine(payloadDir, "scripts"));
            CopyDirectory(resourcesPath, Path.Combine(payloadDir, "resources"));

            var logPath = Path.Combine(taskDir, "install.log");
            var installer = Path.Combine(payloadDir, "scripts", "install_windows.ps1");
            var scriptParams = BuildScriptParams(installer, action, language, allowTakeOwnership, logPath);

            // 勾选接管所有权时直接提权；否则先普通权限跑，权限不足再自动提权重试。
            if (allowTakeOwnership)
            {
                return await RunElevatedAsync(scriptParams, logPath, log, cancellationToken);
            }

            var result = await RunDirectAsync(scriptParams, logPath, log, cancellationToken);
            if (result.ExitCode != 0 && action == "install" && NeedsElevation(result.Output))
            {
                log("普通权限无法写入 Store 目录，正在请求 Windows 管理员权限…");
                var elevatedLogPath = Path.Combine(taskDir, "install-elevated.log");
                var elevatedParams = BuildScriptParams(installer, action, language, allowTakeOwnership, elevatedLogPath);
                result = await RunElevatedAsync(elevatedParams, elevatedLogPath, log, cancellationToken);
            }
            return result;
        }
        finally
        {
            // 任务完成后清理 12MB+ 临时载荷副本，仅保留同级日志文件供查看
            try { if (Directory.Exists(payloadDir)) Directory.Delete(payloadDir, true); } catch { }
        }
    }

    private static Dictionary<string, object> BuildScriptParams(
        string installer, string action, string language, bool allowTakeOwnership, string logPath, bool selfTest = false)
    {
        var parameters = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase)
        {
            ["Script"] = installer,
            ["Action"] = action,
            ["Language"] = language,
            ["OriginalUserSid"] = CurrentUserSid(),
            ["OriginalUserProfile"] = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ["OriginalAppData"] = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            ["OriginalLocalAppData"] = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            ["StageLogPath"] = logPath,
            ["SkipUpdateCheck"] = true,
        };
        if (allowTakeOwnership) parameters["AllowTakeOwnership"] = true;
        if (selfTest) parameters["SelfTest"] = true;
        return parameters;
    }

    private static bool NeedsElevation(string output) =>
        output.Contains("拒绝访问", StringComparison.OrdinalIgnoreCase) ||
        output.Contains("无法写入", StringComparison.OrdinalIgnoreCase) ||
        output.Contains("写入权限", StringComparison.OrdinalIgnoreCase) ||
        output.Contains("Access is denied", StringComparison.OrdinalIgnoreCase) ||
        output.Contains("UnauthorizedAccessException", StringComparison.OrdinalIgnoreCase) ||
        output.Contains("接管所有权", StringComparison.OrdinalIgnoreCase) ||
        output.Contains("takeown", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// 统一的隐藏窗口 PowerShell 执行器：线程安全聚合 stdout/stderr，
    /// 并在进程退出后完整排空异步输出管道，杜绝末尾日志丢失与并发写竞争。
    /// </summary>
    private static async Task<(int ExitCode, string Output)> ExecuteHiddenPowerShellAsync(
        IEnumerable<string> scriptArgs,
        IReadOnlyDictionary<string, string>? environment,
        string startFailureMessage,
        Action<string> log,
        CancellationToken cancellationToken)
    {
        var psi = new ProcessStartInfo
        {
            FileName = "powershell.exe",
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        psi.ArgumentList.Add("-NoProfile");
        psi.ArgumentList.Add("-NonInteractive");
        psi.ArgumentList.Add("-ExecutionPolicy");
        psi.ArgumentList.Add("Bypass");
        psi.ArgumentList.Add("-File");
        foreach (var arg in scriptArgs) psi.ArgumentList.Add(arg);

        if (environment is not null)
        {
            foreach (var kv in environment)
            {
                psi.Environment[kv.Key] = kv.Value;
            }
        }

        var output = new StringBuilder();
        var sync = new object();
        void OnLine(string? line)
        {
            if (line is null) return;
            lock (sync)
            {
                output.AppendLine(line);
            }
            log(line);
        }

        using var process = new Process { StartInfo = psi, EnableRaisingEvents = true };
        process.OutputDataReceived += (_, e) => OnLine(e.Data);
        process.ErrorDataReceived += (_, e) => OnLine(e.Data);
        if (!process.Start()) throw new InvalidOperationException(startFailureMessage);
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        using var killReg = cancellationToken.Register(() =>
        {
            try { if (!process.HasExited) process.Kill(entireProcessTree: true); } catch { }
        });

        await process.WaitForExitAsync(cancellationToken);
        // 无参同步 WaitForExit 用于等待异步 OutputDataReceived / ErrorDataReceived 管道回调全部排空
        process.WaitForExit();

        string finalOutput;
        lock (sync)
        {
            finalOutput = output.ToString();
        }
        return (process.ExitCode, finalOutput);
    }

    private static async Task<InstallResult> RunDirectAsync(
        Dictionary<string, object> parameters, string logPath, Action<string> log, CancellationToken cancellationToken)
    {
        var env = new Dictionary<string, string>
        {
            ["CLAUDE_ZH_STAGE_LOG"] = logPath,
            ["CLAUDE_ZH_SKIP_UPDATE_CHECK"] = "1",
            ["PYTHONUTF8"] = "1",
            ["PYTHONIOENCODING"] = "utf-8",
            ["CLAUDE_ZH_ORIGINAL_USER_SID"] = CurrentUserSid(),
        };

        try
        {
            var (exitCode, text) = await ExecuteHiddenPowerShellAsync(
                BuildCliArguments(parameters),
                env,
                "无法启动 PowerShell 安装器",
                log,
                cancellationToken);

            var fileLog = await ReadSharedTextAsync(logPath, cancellationToken);
            if (!string.IsNullOrWhiteSpace(fileLog) && !text.Contains(fileLog.Trim(), StringComparison.Ordinal))
            {
                text += fileLog;
                log(fileLog);
            }
            return new InstallResult(exitCode, text, logPath, false);
        }
        catch (System.ComponentModel.Win32Exception ex) when (ex.NativeErrorCode == 1223)
        {
            return new InstallResult(1223, "已取消 Windows 管理员授权，未继续提权安装。", logPath, false);
        }
    }

    /// <summary>
    /// 提权执行。
    /// UseShellExecute=true（runas 必需）时 .NET 不允许设置 Environment，
    /// 所以环境变量全部写进生成的包装脚本里；退出码由包装脚本原样传出。
    /// </summary>
    private static async Task<InstallResult> RunElevatedAsync(
        Dictionary<string, object> parameters, string logPath, Action<string> log, CancellationToken cancellationToken)
    {
        var wrapperPath = Path.Combine(Path.GetDirectoryName(logPath)!, "elevated-wrapper.ps1");
        File.WriteAllText(wrapperPath, BuildWrapperScript(parameters, logPath), new UTF8Encoding(true));

        var psi = new ProcessStartInfo
        {
            FileName = "powershell.exe",
            UseShellExecute = true,
            Verb = "runas",
            WindowStyle = ProcessWindowStyle.Normal,
        };
        psi.ArgumentList.Add("-NoProfile");
        psi.ArgumentList.Add("-NonInteractive");
        psi.ArgumentList.Add("-ExecutionPolicy");
        psi.ArgumentList.Add("Bypass");
        psi.ArgumentList.Add("-File");
        psi.ArgumentList.Add(wrapperPath);

        var output = new StringBuilder();
        try
        {
            using var process = new Process { StartInfo = psi, EnableRaisingEvents = true };
            if (!process.Start()) throw new InvalidOperationException("无法启动提权安装器");

            // 提权进程在独立窗口运行，输出回不来，靠共享 transcript 实时回传界面。
            await PumpLogAsync(logPath, log, () => process.HasExited, cancellationToken);
            await process.WaitForExitAsync(cancellationToken);

            var fileLog = await ReadSharedTextAsync(logPath, cancellationToken);
            if (!string.IsNullOrWhiteSpace(fileLog)) output.Append(fileLog);
            return new InstallResult(process.ExitCode, output.ToString(), logPath, true);
        }
        catch (System.ComponentModel.Win32Exception ex) when (ex.NativeErrorCode == 1223)
        {
            return new InstallResult(1223, "已取消 Windows 管理员授权，未继续提权安装。", logPath, true);
        }
    }

    public static async Task<InstallResult> RunDirectSelfTest(string installer, string workDir, Action<string> log)
    {
        Directory.CreateDirectory(workDir);
        var logPath = Path.Combine(workDir, "direct.log");
        var parameters = BuildScriptParams(installer, "uninstall", "zh-CN", false, logPath, selfTest: true);
        var env = new Dictionary<string, string>
        {
            ["CLAUDE_ZH_STAGE_LOG"] = logPath,
            ["CLAUDE_ZH_SKIP_UPDATE_CHECK"] = "1",
        };
        var (exitCode, text) = await ExecuteHiddenPowerShellAsync(
            BuildCliArguments(parameters),
            env,
            "无法启动直连自检",
            log,
            CancellationToken.None);
        return new InstallResult(exitCode, text, logPath, false);
    }

    public static async Task<InstallResult> RunWrapperSelfTest(string installer, string workDir, Action<string> log)
    {
        Directory.CreateDirectory(workDir);
        var logPath = Path.Combine(workDir, "wrapper.log");
        var parameters = BuildScriptParams(installer, "uninstall", "zh-CN", false, logPath, selfTest: true);
        var wrapperPath = Path.Combine(workDir, "elevated-wrapper.ps1");
        File.WriteAllText(wrapperPath, BuildWrapperScript(parameters, logPath), new UTF8Encoding(true));

        var (exitCode, text) = await ExecuteHiddenPowerShellAsync(
            [wrapperPath],
            null,
            "无法启动包装脚本自检",
            log,
            CancellationToken.None);
        return new InstallResult(exitCode, text, logPath, true);
    }

    private static string BuildWrapperScript(Dictionary<string, object> parameters, string logPath)
    {
        var assignments = parameters
            .Where(p => p.Key != "Script")
            .Select(p => p.Value is bool flag
                ? $"    {p.Key} = {(flag ? "$true" : "$false")}"
                : $"    {p.Key} = {PsLiteral(p.Value as string ?? "")}");

        var scriptPath = parameters.TryGetValue("Script", out var value) ? value as string ?? "" : "";
        var sb = new StringBuilder();
        sb.AppendLine("$ErrorActionPreference = 'Stop'");
        sb.AppendLine("[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()");
        sb.AppendLine("if (-not [Console]::IsInputRedirected) { try { Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class QEC { [DllImport(\"kernel32.dll\")] static extern IntPtr GetStdHandle(int n); [DllImport(\"kernel32.dll\")] static extern bool GetConsoleMode(IntPtr h, out uint m); [DllImport(\"kernel32.dll\")] static extern bool SetConsoleMode(IntPtr h, uint m); public static void Off(){ IntPtr h=GetStdHandle(-10); uint m; if(GetConsoleMode(h,out m)) SetConsoleMode(h,(m & ~0x0040u)|0x0080u); } }'; [QEC]::Off() } catch {} }");
        sb.AppendLine($"$env:CLAUDE_ZH_STAGE_LOG = {PsLiteral(logPath)}");
        sb.AppendLine("$env:CLAUDE_ZH_SKIP_UPDATE_CHECK = '1'");
        sb.AppendLine("$env:PYTHONUTF8 = '1'");
        sb.AppendLine("$env:PYTHONIOENCODING = 'utf-8'");
        sb.AppendLine($"$env:CLAUDE_ZH_ORIGINAL_USER_SID = {PsLiteral(CurrentUserSid())}");
        sb.AppendLine("$scriptParams = @{");
        foreach (var assignment in assignments) sb.AppendLine(assignment);
        sb.AppendLine("}");
        sb.AppendLine($"& {PsLiteral(scriptPath)} @scriptParams");
        sb.AppendLine("exit $LASTEXITCODE");
        return sb.ToString();
    }

    private static List<string> BuildCliArguments(Dictionary<string, object> parameters)
    {
        var arguments = new List<string>
        {
            parameters["Script"] as string ?? "",
            parameters["Action"] as string ?? "install",
            parameters["Language"] as string ?? "zh-CN",
            "-OriginalUserSid", parameters["OriginalUserSid"] as string ?? "",
            "-OriginalUserProfile", parameters["OriginalUserProfile"] as string ?? "",
            "-OriginalAppData", parameters["OriginalAppData"] as string ?? "",
            "-OriginalLocalAppData", parameters["OriginalLocalAppData"] as string ?? "",
            "-StageLogPath", parameters["StageLogPath"] as string ?? "",
            "-SkipUpdateCheck",
        };
        if (parameters.ContainsKey("AllowTakeOwnership")) arguments.Add("-AllowTakeOwnership");
        if (parameters.ContainsKey("SelfTest")) arguments.Add("-SelfTest");
        return arguments;
    }

    private static string PsLiteral(string value) => "'" + value.Replace("'", "''") + "'";

    private static async Task PumpLogAsync(string logPath, Action<string> log, Func<bool> finished, CancellationToken cancellationToken)
    {
        var emitted = 0;
        while (!finished())
        {
            await Task.Delay(400, cancellationToken);
            var text = await ReadSharedTextAsync(logPath, cancellationToken);
            if (text.Length < emitted) emitted = 0;
            if (text.Length <= emitted) continue;
            var chunk = text[emitted..];
            emitted = text.Length;
            log(chunk.TrimEnd('\r', '\n'));
        }
    }

    private static async Task<string> ReadSharedTextAsync(string path, CancellationToken cancellationToken)
    {
        if (!File.Exists(path)) return "";
        for (var attempt = 0; attempt < 5; attempt++)
        {
            try
            {
                using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                using var buffer = new MemoryStream();
                await stream.CopyToAsync(buffer, cancellationToken);
                return DecodeText(buffer.ToArray());
            }
            catch (FileNotFoundException) { return ""; }
            catch (DirectoryNotFoundException) { return ""; }
            catch (IOException) { await Task.Delay(120, cancellationToken); }
            catch (UnauthorizedAccessException) { await Task.Delay(120, cancellationToken); }
        }
        return "";
    }

    private static string DecodeText(byte[] bytes)
    {
        if (bytes.Length >= 2)
        {
            if (bytes[0] == 0xFF && bytes[1] == 0xFE) return Encoding.Unicode.GetString(bytes, 2, bytes.Length - 2);
            if (bytes[0] == 0xFE && bytes[1] == 0xFF) return Encoding.BigEndianUnicode.GetString(bytes, 2, bytes.Length - 2);
        }
        var nulCount = 0;
        for (var i = 0; i + 1 < Math.Min(bytes.Length, 400); i += 2) if (bytes[i] == 0) nulCount++;
        var text = nulCount > 20 ? Encoding.Unicode.GetString(bytes) : new UTF8Encoding(false).GetString(bytes);
        return text.TrimStart('\uFEFF');
    }

    private static async Task<InstallResult> RunAntigravityDirectAsync(
        string installer,
        string action,
        string language,
        string logPath,
        Action<string> log,
        CancellationToken cancellationToken,
        bool selfTest = false)
    {
        var args = new List<string>
        {
            installer,
            action,
            language,
            "-OriginalLocalAppData",
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "-StageLogPath",
            logPath,
        };
        if (selfTest) args.Add("-SelfTest");

        var env = new Dictionary<string, string>
        {
            ["CLAUDE_ZH_STAGE_LOG"] = logPath,
        };

        var (exitCode, text) = await ExecuteHiddenPowerShellAsync(
            args,
            env,
            "无法启动 Antigravity PowerShell 安装器",
            log,
            cancellationToken);

        var fileLog = await ReadSharedTextAsync(logPath, cancellationToken);
        if (!string.IsNullOrWhiteSpace(fileLog) && !text.Contains(fileLog.Trim(), StringComparison.Ordinal))
        {
            text += fileLog;
            log(fileLog);
        }
        return new InstallResult(exitCode, text, logPath, false);
    }

    public static async Task<InstallResult> RunAntigravitySelfTest(string installer, string workDir, Action<string> log)
    {
        Directory.CreateDirectory(workDir);
        var logPath = Path.Combine(workDir, "antigravity-selftest.log");
        return await RunAntigravityDirectAsync(installer, "uninstall", "zh-CN", logPath, log, CancellationToken.None, selfTest: true);
    }

    private static void CopyDirectory(string source, string destination)
    {
        Directory.CreateDirectory(destination);
        foreach (var file in Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories))
        {
            var relative = Path.GetRelativePath(source, file);
            var target = Path.Combine(destination, relative);
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.Copy(file, target, true);
        }
    }
}
