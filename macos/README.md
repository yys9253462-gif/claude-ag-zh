# Claude & Antigravity 中文助手 · macOS 便携版 0.5.0

这是 Mac 专用的双端启动器与离线汉化资源包，不依赖 Windows 可执行程序或 Magpie。

- **Antigravity 简体中文全面汉化（v0.5.0 同源）**：
  - 5,543 条主界面与斜杠命令词条 + 385 条动态正则规则，完整覆盖全部 18 个核心斜杠命令、16 个内置技能、官方市场插件与 6 大前端引擎修复；
  - 完整内嵌 `/swarm` 蜂群面板专精翻译器与协议响应拦截钩子，本地与远程安全外壳协议（SSH）蜂群双端生效；
  - 原生菜单栏、托盘与加载页汉化；
  - 采用就地无损归档差量修补，不触碰 `app.asar.unpacked` 原生扩展，自动同步 `ElectronAsarIntegrity` 摘要并保留原应用权限清单重签。
- **Claude Desktop 三语汉化**：支持简体中文（`zh-CN`）、繁體中文（台灣 `zh-TW`）、繁體中文（香港 `zh-HK`）。

**验证状态：已在构建机完成打包、真实 Antigravity 归档沙箱差量修补/完整性哈希同步/无损还原实测、Shell 语法检查、ZIP 字节一致性与 Unix 执行权限校验；尚未在真实 macOS 实机上验收 `codesign` 临时签名、图形确认框与启动流程。**

## 使用前提

- macOS 11 或更新版本（支持 Apple Silicon 与 Intel）。
- 目标应用位于 `/Applications` 或用户 `~/Applications` 目录：
  - Antigravity：`/Applications/Antigravity.app` 或 `~/Applications/Antigravity.app`
  - Claude Desktop：`/Applications/Claude.app` 或 `~/Applications/Claude.app`
- 已安装 **Python 3.10 或更新版本**（支持 Homebrew `/opt/homebrew/bin/python3`、python.org `/usr/local/bin/python3` 或系统 `/usr/bin/python3`）。
- 若目标应用安装在系统 `/Applications` 目录，修改与重签名时需要输入 Mac 管理员登录密码（密码由系统 `sudo` 读取，绝不记录到日志）。

## 使用方法

- **方式一（推荐 · 原生 `.dmg` 镜像）**：双击打开 `ClaudeDesktop-ZH-CN-macOS-0.5.0.dmg`，将 `ClaudeDesktop-ZH-CN.app` 拖入右侧 `Applications` 文件夹后打开（也可直接在镜像窗口双击 `打开中文助手.command`）。
- **方式二（便携 `.zip` 压缩包）**：解压 `ClaudeDesktop-ZH-CN-macOS-0.5.0.zip`，保持 `.app` 与其内部目录完整。

1. 打开后按以下流程操作：
2. 双击 `ClaudeDesktop-ZH-CN.app`（或双击备用入口 `打开中文助手.command`）。
3. 在弹出的操作选择窗口中选择目标应用与操作（例如「Antigravity · 简体中文（含蜂群与全部斜杠命令）」），点击「下一步」。此时不会修改或关闭任何应用。
4. 保存当前工作后，在确认框点击「开始执行」。如需管理员权限，在终端窗口输入登录密码（输入时不会回显字符）。
5. 完成后工具会自动尝试重新打开目标应用，检查中文界面、斜杠命令与蜂群面板是否生效。

> 本工具没有 Apple Developer ID 签名或公证。如 macOS 提示无法验证开发者，请在「系统设置 → 隐私与安全性」中选择「仍要打开」，或在终端直接运行 `bash "打开中文助手.command"`（请勿全局关闭 Gatekeeper）。

## 无损恢复与日志

- 重新打开本工具，选择对应应用的「恢复官方原版（使用备份）」即可将完整官方备份无损恢复（含官方原签名）。
- 官方备份保存在应用同级目录：
  - Antigravity：`Antigravity.backup-before-zh-CN-<时间戳>.app`
  - Claude Desktop：`Claude.backup-before-zh-CN-<时间戳>.app`
- 命令行高级用法（直接调用 Antigravity 补丁器）：
  ```bash
  python3 -I "ClaudeDesktop-ZH-CN.app/Contents/Resources/scripts/patch_antigravity_macos.py" --app "/Applications/Antigravity.app"
  python3 -I "ClaudeDesktop-ZH-CN.app/Contents/Resources/scripts/patch_antigravity_macos.py" --app "/Applications/Antigravity.app" --restore
  ```
- 运行日志统一保存在 `~/Library/Logs/ClaudeDesktop-ZH-CN/`。

## 开发与校验

重新打包 `.zip`（跨平台，仅需 Python 标准库）或在 macOS 构建原生 `.dmg`（`bash macos/build_dmg.sh`）：

```bash
python3 -I macos/package.py
```

产物位于 `artifacts/macos/ClaudeDesktop-ZH-CN-macOS-0.5.0.zip` 与同名 `.sha256` 校验文件。

仅做只读资源完整性检查（不关闭也不修改本机任何应用）：

```bash
bash "ClaudeDesktop-ZH-CN.app/Contents/Resources/launch.command" --check
```

## 许可

MIT。详见包内 `LICENSE`、`NOTICE.md`、`UPSTREAM.lock.json` 以及 `resources/antigravity/LICENSE*`。本项目为非官方汉化工具。
