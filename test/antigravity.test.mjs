import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createRequire } from "node:module";
import { createRunner } from "../lib/runner.mjs";

const read = (path) => readFile(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
const agScriptPath = () => fileURLToPath(new URL("../scripts/install_antigravity_windows.ps1", import.meta.url));

function buildMiniAsar(filesMap) {
  const entries = Object.entries(filesMap);
  const filesTree = { dist: { files: {} } };
  const chunks = [];
  let offset = 0;

  for (const [name, content] of entries) {
    const buf = Buffer.from(content, "utf8");
    filesTree.dist.files[name] = { size: buf.length, offset: String(offset) };
    chunks.push(buf);
    offset += buf.length;
  }

  const headerJsonBuf = Buffer.from(JSON.stringify({ files: filesTree }), "utf8");
  const alignedHeaderLen = Math.ceil(headerJsonBuf.length / 4) * 4;
  const headerPadded = Buffer.alloc(alignedHeaderLen, 0);
  headerJsonBuf.copy(headerPadded);

  const headerBuf = Buffer.alloc(16);
  headerBuf.writeUInt32LE(4, 0);
  headerBuf.writeUInt32LE(8 + alignedHeaderLen, 4);
  headerBuf.writeUInt32LE(4 + alignedHeaderLen, 8);
  headerBuf.writeUInt32LE(headerJsonBuf.length, 12);

  return Buffer.concat([headerBuf, headerPadded, ...chunks]);
}

test("Antigravity PowerShell 安装器语法有效且支持只读 SelfTest", { skip: process.platform !== "win32" }, async () => {
  const file = agScriptPath();
  const syntax = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    `$null = [scriptblock]::Create((Get-Content -LiteralPath '${file.replaceAll("'", "''")}' -Raw))`
  ], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);

  const selfTest = spawnSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file,
    "uninstall", "zh-CN", "-SelfTest"
  ], { encoding: "utf8" });
  assert.equal(selfTest.status, 0, selfTest.stdout + selfTest.stderr);
  assert.match(selfTest.stdout, /只读自检通过/);
});

test("Antigravity 沙箱端到端：ASAR 解包、幂等注入与无损还原", { skip: process.platform !== "win32" }, async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "ag-patch-test-"));
  try {
    const appDir = join(tempRoot, "Programs", "antigravity");
    const resDir = join(appDir, "resources");
    await mkdir(resDir, { recursive: true });

    const originalAsar = buildMiniAsar({
      "preload.js": "console.log('preload-origin');\n",
      "menu.js": "const { Menu } = require('electron');\n",
      "redirects.js": "exports.pluginResponse = function(res) { return res; };\n",
      "tray.js": "const items = [{ label: 'Show Antigravity' }, { label: 'Quit' }];\n",
      "loadingOverlay.js": "const html = '<div>Loading Antigravity</div>';\n",
    });
    const asarPath = join(resDir, "app.asar");
    await writeFile(asarPath, originalAsar);

    // 1. 首次安装
    const installRes = spawnSync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", agScriptPath(),
      "install", "zh-CN", "-AppDirOverride", appDir, "-SkipLaunch", "-SkipProcessStop"
    ], { encoding: "utf8" });
    assert.equal(installRes.status, 0, installRes.stdout + installRes.stderr);

    // app.asar 已被改名为 app.asar.disabled
    await assert.rejects(() => stat(asarPath));
    assert.ok((await stat(asarPath + ".disabled")).isFile());

    const preload = await readFile(join(resDir, "app", "dist", "preload.js"), "utf8");
    const menu = await readFile(join(resDir, "app", "dist", "menu.js"), "utf8");
    const redirects = await readFile(join(resDir, "app", "dist", "redirects.js"), "utf8");
    const swarmCopied = await readFile(join(resDir, "app", "dist", "swarm-translator.js"), "utf8");
    const tray = await readFile(join(resDir, "app", "dist", "tray.js"), "utf8");
    const loading = await readFile(join(resDir, "app", "dist", "loadingOverlay.js"), "utf8");

    assert.match(preload, /preload-origin/);
    assert.match(preload, /Antigravity Chinese Localization Engine/);
    assert.match(menu, /Antigravity Chinese Localization Engine - Menu/);
    assert.match(redirects, /Antigravity Chinese Localization Engine - Swarm/);
    assert.match(swarmCopied, /Antigravity Chinese Localization Engine - Swarm Board/);
    assert.match(tray, /显示 Antigravity/);
    assert.match(tray, /退出/);
    assert.match(loading, />正在加载 Antigravity</);

    // 2. 重复安装（热更新词典，不重复叠加两份）
    const reinstallRes = spawnSync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", agScriptPath(),
      "install", "zh-CN", "-AppDirOverride", appDir, "-SkipLaunch", "-SkipProcessStop"
    ], { encoding: "utf8" });
    assert.equal(reinstallRes.status, 0, reinstallRes.stdout + reinstallRes.stderr);
    const preloadAfter = await readFile(join(resDir, "app", "dist", "preload.js"), "utf8");
    assert.equal(preloadAfter.split("Antigravity Chinese Localization Engine").length - 1, 1);
    const redirectsAfter = await readFile(join(resDir, "app", "dist", "redirects.js"), "utf8");
    assert.equal(redirectsAfter.split("Antigravity Chinese Localization Engine - Swarm").length - 1, 1);

    // 3. 还原官方文件
    const uninstallRes = spawnSync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", agScriptPath(),
      "uninstall", "zh-CN", "-AppDirOverride", appDir, "-SkipLaunch", "-SkipProcessStop"
    ], { encoding: "utf8" });
    assert.equal(uninstallRes.status, 0, uninstallRes.stdout + uninstallRes.stderr);

    const restoredBuf = await readFile(asarPath);
    assert.equal(Buffer.compare(restoredBuf, originalAsar), 0, "还原后的 app.asar 应与原版逐字节一致");
    await assert.rejects(() => stat(asarPath + ".disabled"));
    await assert.rejects(() => stat(join(resDir, "app")));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Runner 校验 Antigravity 目标参数与只允许简体中文", async () => {
  const calls = [];
  const runner = createRunner({
    platform: "win32",
    stateDir: await mkdtemp(join(tmpdir(), "ag-runner-test-")),
    execute: async (cmd, args) => {
      calls.push({ cmd, args });
      return { code: 0, output: "ok" };
    },
  });

  assert.throws(() => runner.begin({ target: "unknown", action: "install", language: "zh-CN" }), /目标应用/);
  assert.throws(() => runner.begin({ target: "antigravity", action: "install", language: "zh-TW" }), /仅支持简体中文/);
  assert.throws(() => runner.begin({ target: "antigravity", action: "install", language: "zh-CN", allowTakeOwnership: true }), /WindowsApps/);

  runner.begin({ target: "antigravity", action: "install", language: "zh-CN" });
  await runner.active.done;
  assert.equal(calls.length, 1);
  assert.match(calls[0].args.join(" "), /install_antigravity_windows\.ps1/);
});

test("Antigravity 上游资源与 MIT 许可保留完整", async () => {
  const lock = JSON.parse(await read("UPSTREAM.lock.json"));
  assert.equal(lock.antigravity.project, "MIMICTE/Antigravity-zh-CN");
  assert.match(await read("resources/antigravity/LICENSE"), /Copyright \(c\) 2026 Antigravity-zh Contributors/);
  assert.match(await read("resources/antigravity/dom-translator.js"), /Antigravity Chinese Localization Engine/);
  assert.match(await read("resources/antigravity/menu-translator.js"), /Antigravity Chinese Localization Engine - Menu/);
});

test("蜂群协议响应钩子仅向 swarm-board 页面内联注入翻译器，不影响其他插件与重定向", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "ag-swarm-hook-"));
  try {
    const swarmTranslator = await read("resources/antigravity/swarm-translator.js");
    const swarmHook = await read("resources/antigravity/swarm-redirects-hook.js");
    // 显式写入 CommonJS 标记，避免宿主临时目录上级残留 "type": "module" 干扰
    await writeFile(join(tempDir, "package.json"), JSON.stringify({ type: "commonjs" }), "utf8");
    await writeFile(join(tempDir, "swarm-translator.js"), swarmTranslator, "utf8");
    const fakeRedirects = join(tempDir, "redirects.js");
    await writeFile(
      fakeRedirects,
      `exports.pluginResponse = function(response) { return response; };\n\n${swarmHook}\n`,
      "utf8"
    );

    const localRequire = createRequire(import.meta.url);
    const mod = localRequire(fakeRedirects);

    // 1. 蜂群面板 HTML 必须注入翻译器并移除旧 content-length
    const swarmHtml = '<!doctype html><html><body><div id="board" data-testid="swarm-board">Board</div></body></html>';
    const swarmRes = await mod.pluginResponse(
      new Response(swarmHtml, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "content-length": String(swarmHtml.length), etag: '"abc"' },
      })
    );
    const swarmBody = await swarmRes.text();
    assert.match(swarmBody, /Antigravity Chinese Localization Engine - Swarm Board/);
    assert.ok(swarmBody.includes("已完成 $1 / $2 项任务"), "替换逻辑不得吞掉脚本源码中的 $1/$2 占位符");
    assert.ok(swarmBody.indexOf("<script>") < swarmBody.indexOf("</body>"), "脚本应插在 </body> 之前");
    assert.equal(swarmRes.headers.get("content-length"), null, "注入后必须移除过期 content-length");
    assert.equal(swarmRes.headers.get("etag"), null, "注入后必须移除过期 etag");

    // 1b. 已注入过的 HTML 再次经过钩子不得重复插入第二个脚本
    const secondRes = await mod.pluginResponse(
      new Response(swarmBody, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })
    );
    const secondBody = await secondRes.text();
    assert.equal(secondBody.split("Antigravity Chinese Localization Engine - Swarm Board").length - 1, 1);

    // 2. 其他非蜂群边车 HTML 原样透传，绝不注入
    const otherHtml = '<!doctype html><html><body><div id="other-plugin">Hello</div></body></html>';
    const otherRes = await mod.pluginResponse(
      new Response(otherHtml, { status: 200, headers: { "content-type": "text/html" } })
    );
    const otherBody = await otherRes.text();
    assert.equal(otherBody, otherHtml);

    // 3. JSON / 空响应体（如 HEAD 请求）保持原样同步返回
    const jsonRes = new Response('{"swarm":"ok"}', { status: 200, headers: { "content-type": "application/json" } });
    assert.equal(mod.pluginResponse(jsonRes), jsonRes);
    const headRes = new Response(null, { status: 200, headers: { "content-type": "text/html" } });
    assert.equal(mod.pluginResponse(headRes), headRes);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("蜂群前端翻译引擎覆盖静态标签、动态进度、SVG 与微任务防闪烁，并严格隔离消息正文与代号", async () => {
  const swarmCode = await read("resources/antigravity/swarm-translator.js");

  // 构造极简内存 DOM 树用于实测遍历、属性翻译、物理隔离与 MutationObserver 微任务刷新
  function makeEl(tag, { id = "", classes = [], attrs = {}, text = "", parent = null } = {}) {
    const attrMap = new Map(Object.entries(attrs));
    const el = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      id,
      classList: { contains: (c) => classes.includes(c) },
      parentElement: parent,
      children: [],
      hasAttribute: (k) => attrMap.has(k),
      getAttribute: (k) => attrMap.get(k) ?? null,
      setAttribute: (k, v) => attrMap.set(k, String(v)),
      closest(sel) {
        const parts = sel.split(",").map((s) => s.trim());
        let cur = this;
        while (cur) {
          for (const part of parts) {
            if (part.startsWith("#") && cur.id === part.slice(1)) return cur;
            if (part.startsWith(".") && !part.includes(" ") && !part.includes(":") && cur.classList.contains(part.slice(1))) return cur;
            if (part === cur.tagName.toLowerCase()) return cur;
            if (part === ".hv-svg text" && cur.tagName === "TEXT" && cur.parentElement?.classList?.contains("hv-svg")) return cur;
            if (part === '[data-testid="swarm-member-workspace"]' && cur.getAttribute("data-testid") === "swarm-member-workspace") return cur;
          }
          cur = cur.parentElement;
        }
        return null;
      },
    };
    if (text) {
      el.textNode = { nodeType: 3, nodeValue: text, parentElement: el };
    }
    if (parent) parent.children.push(el);
    return el;
  }

  const rootBody = makeEl("body");
  const tabBoard = makeEl("button", { parent: rootBody, text: "Board" });
  const liveLabel = makeEl("span", { id: "live-label", parent: rootBody, text: "Live" });
  const searchInput = makeEl("input", { id: "f-search", parent: rootBody, attrs: { placeholder: "Search", "aria-label": "Search posts" } });
  const optFrom = makeEl("option", { parent: rootBody, text: "From anyone" });
  const optFromMember = makeEl("option", { parent: rootBody, text: "From worker-1" });
  const progText = makeEl("span", { parent: rootBody, text: "3 of 5 tasks done" });
  const coordNeeds = makeEl("span", { parent: rootBody, text: "Coordinator · 2 of 5 done · Needs you" });
  const readAgo = makeEl("span", { parent: rootBody, text: "read #12 · updated 3m ago" });
  const waitBadge = makeEl("span", { classes: ["o2-tw"], parent: rootBody, text: "Waiting on @coordinator" });
  const alertItem = makeEl("div", { parent: rootBody, text: "@worker-2 ran out of quota" });
  const hvSvg = makeEl("svg", { classes: ["hv-svg"], parent: rootBody });
  const hvText = makeEl("text", { classes: ["hv-t"], parent: hvSvg, text: "Coordinator" });
  const liveAct = makeEl("div", { classes: ["o2-mact"], parent: rootBody, text: "Read app.js" });

  // 严格隔离区：绝不可被误翻
  const msgBody = makeEl("div", { classes: ["msg-body"], parent: rootBody, text: "Board" });
  const rawPre = makeEl("pre", { id: "raw", classes: ["raw"], parent: rootBody, text: '{"status":"Waiting"}' });
  const authorSpan = makeEl("span", { classes: ["o2-mauth"], parent: rootBody, text: "Coordinator" });
  const wsTag = makeEl("span", { parent: rootBody, attrs: { "data-testid": "swarm-member-workspace" }, text: "share · ~/repo" });

  function collectAll(node, list = []) {
    list.push(node);
    if (node.textNode) list.push(node.textNode);
    for (const c of node.children || []) collectAll(c, list);
    return list;
  }

  let observerCb = null;
  const docEl = { lang: "en", nodeType: 1 };
  const fakeDoc = {
    readyState: "complete",
    title: "Swarm",
    documentElement: docEl,
    body: rootBody,
    createTreeWalker(root) {
      const items = collectAll(root);
      let idx = 0;
      return { nextNode: () => items[idx++] || null };
    },
  };

  const sandbox = {
    document: fakeDoc,
    console,
    Map,
    Set,
    Object,
    Array,
    RegExp,
    String,
    Promise,
    queueMicrotask,
    MutationObserver: class {
      constructor(cb) { observerCb = cb; }
      observe() {}
      disconnect() {}
    },
  };
  sandbox.window = sandbox;

  vm.runInNewContext(swarmCode, sandbox);

  assert.equal(fakeDoc.title, "蜂群");
  assert.equal(tabBoard.textNode.nodeValue, "公告板");
  assert.equal(liveLabel.textNode.nodeValue, "实时");
  assert.equal(searchInput.getAttribute("placeholder"), "搜索");
  assert.equal(searchInput.getAttribute("aria-label"), "搜索公告");
  assert.equal(optFrom.textNode.nodeValue, "任意发送者");
  assert.equal(optFromMember.textNode.nodeValue, "来自 worker-1");
  assert.equal(progText.textNode.nodeValue, "已完成 3 / 5 项任务");
  assert.equal(coordNeeds.textNode.nodeValue, "协调者 · 已完成 2 / 5 · 等待您确认");
  assert.equal(readAgo.textNode.nodeValue, "已读至 #12 · 3 分钟前更新");
  assert.equal(waitBadge.textNode.nodeValue, "等待 @coordinator");
  assert.equal(alertItem.textNode.nodeValue, "@worker-2 配额已耗尽");
  assert.equal(hvText.textNode.nodeValue, "协调者");
  assert.equal(liveAct.textNode.nodeValue, "正在读取 app.js");

  // 物理隔离区必须原封不动
  assert.equal(msgBody.textNode.nodeValue, "Board", "公告正文绝不可被误翻");
  assert.equal(rawPre.textNode.nodeValue, '{"status":"Waiting"}', "原始 JSON 绝不可被误翻");
  assert.equal(authorSpan.textNode.nodeValue, "Coordinator", "成员代号绝不可被误翻");
  assert.equal(wsTag.textNode.nodeValue, "share · ~/repo", "工作区路径绝不可被误翻");

  // 模拟 app.js 轮询把 liveLabel 改回 'Live'，验证微任务自动翻回 '实时'
  liveLabel.textNode.nodeValue = "Live";
  observerCb([{ type: "characterData", target: liveLabel.textNode }]);
  await new Promise((r) => queueMicrotask(r));
  assert.equal(liveLabel.textNode.nodeValue, "实时");
});

/**
 * 构造专用于验证 dom-translator.js 的内存 DOM 沙箱，支持选择器匹配、文本拼接、
 * 浮层扫描（pointerenter -> scanFloatingPortals）与 MutationObserver 回调实测。
 */
function createDomTranslatorSandbox() {
  function matchSingleSelector(el, rawSel) {
    if (!el || el.nodeType !== 1) return false;
    const sel = rawSel.trim();
    if (!sel) return false;

    // 处理后代选择器（如 '[data-testid="user-input-step"] [data-quotable="true"]'）
    const parts = sel.split(/\s+/).filter(Boolean);
    if (parts.length > 1) {
      if (!matchSimpleCompound(el, parts[parts.length - 1])) return false;
      let ancestor = el.parentElement;
      let idx = parts.length - 2;
      while (ancestor && idx >= 0) {
        if (matchSimpleCompound(ancestor, parts[idx])) idx--;
        ancestor = ancestor.parentElement;
      }
      return idx < 0;
    }
    return matchSimpleCompound(el, sel);
  }

  function matchSimpleCompound(el, compound) {
    let rest = compound;
    // 提取可选前缀标签名（如 span.truncate、input[role="combobox"]）
    const tagMatch = rest.match(/^([a-zA-Z0-9_-]+)/);
    if (tagMatch) {
      if (el.tagName !== tagMatch[1].toUpperCase()) return false;
      rest = rest.slice(tagMatch[0].length);
    }
    // 依次校验类选择器、ID 选择器与属性选择器
    const tokenRe = /(\.[a-zA-Z0-9_-]+|#[a-zA-Z0-9_-]+|\[[^\]]+\])/g;
    let matchedLen = 0;
    let m;
    while ((m = tokenRe.exec(rest)) !== null) {
      matchedLen += m[0].length;
      const tok = m[1];
      if (tok.startsWith(".")) {
        if (!el.classList.contains(tok.slice(1))) return false;
      } else if (tok.startsWith("#")) {
        if (el.id !== tok.slice(1)) return false;
      } else if (tok.startsWith("[")) {
        const inner = tok.slice(1, -1);
        const eqIdx = inner.indexOf("=");
        if (eqIdx === -1) {
          if (!el.hasAttribute(inner)) return false;
        } else {
          const isContains = inner[eqIdx - 1] === "*";
          const attrName = isContains ? inner.slice(0, eqIdx - 1) : inner.slice(0, eqIdx);
          const expected = inner.slice(eqIdx + 1).replace(/^["']|["']$/g, "");
          const actual = el.getAttribute(attrName);
          if (actual === null) return false;
          if (isContains) {
            if (!actual.includes(expected)) return false;
          } else if (actual !== expected) {
            return false;
          }
        }
      }
    }
    return matchedLen === rest.length;
  }

  function matchSelectorList(el, selectorList) {
    const list = selectorList.split(",");
    for (const part of list) {
      if (matchSingleSelector(el, part)) return true;
    }
    return false;
  }

  function linkChildren(parent) {
    for (let i = 0; i < parent.childNodes.length; i++) {
      const child = parent.childNodes[i];
      child.parentElement = parent.nodeType === 1 ? parent : null;
      child.previousSibling = i > 0 ? parent.childNodes[i - 1] : null;
      child.nextSibling = i + 1 < parent.childNodes.length ? parent.childNodes[i + 1] : null;
    }
    parent.firstChild = parent.childNodes[0] || null;
  }

  function makeText(text, parent = null) {
    const node = {
      nodeType: 3,
      nodeValue: text,
      parentElement: null,
      previousSibling: null,
      nextSibling: null,
      get textContent() {
        return this.nodeValue;
      },
      set textContent(v) {
        this.nodeValue = String(v);
      },
    };
    if (parent) parent.appendChild(node);
    return node;
  }

  function makeEl(tag, { id = "", classes = [], attrs = {}, text = null, parent = null } = {}) {
    const attrMap = new Map(Object.entries(attrs));
    const el = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      id,
      classList: { contains: (c) => classes.includes(c) },
      className: classes.join(" "),
      parentElement: null,
      previousSibling: null,
      nextSibling: null,
      childNodes: [],
      firstChild: null,
      isContentEditable: false,
      appendChild(child) {
        this.childNodes.push(child);
        linkChildren(this);
        return child;
      },
      hasAttribute: (k) => attrMap.has(k),
      getAttribute: (k) => (attrMap.has(k) ? attrMap.get(k) : null),
      setAttribute: (k, v) => attrMap.set(k, String(v)),
      contains(target) {
        let cur = target;
        while (cur) {
          if (cur === this) return true;
          cur = cur.parentElement;
        }
        return false;
      },
      closest(sel) {
        let cur = this;
        while (cur) {
          if (matchSelectorList(cur, sel)) return cur;
          cur = cur.parentElement;
        }
        return null;
      },
      querySelectorAll(sel) {
        const res = [];
        const visit = (n) => {
          for (const c of n.childNodes || []) {
            if (c.nodeType === 1) {
              if (matchSelectorList(c, sel)) res.push(c);
              visit(c);
            }
          }
        };
        visit(this);
        return res;
      },
      querySelector(sel) {
        return this.querySelectorAll(sel)[0] || null;
      },
      get textContent() {
        let out = "";
        for (const c of this.childNodes) {
          out += c.nodeType === 3 ? (c.nodeValue || "") : c.textContent;
        }
        return out;
      },
      set textContent(v) {
        this.childNodes = [];
        if (v !== "") makeText(String(v), this);
        else linkChildren(this);
      },
    };
    if (text !== null) makeText(text, el);
    if (parent) parent.appendChild(el);
    return el;
  }

  const rootHtml = makeEl("html", { attrs: { lang: "en" } });
  rootHtml.lang = "en";
  const rootBody = makeEl("body", { parent: rootHtml });

  const docListeners = new Map();
  const pendingTimers = [];
  let observerCb = null;
  let observedOptions = null;

  function collectWalkNodes(root, list = []) {
    for (const c of root.childNodes || []) {
      list.push(c);
      if (c.nodeType === 1) collectWalkNodes(c, list);
    }
    return list;
  }

  const fakeDoc = {
    nodeType: 9,
    readyState: "complete",
    documentElement: rootHtml,
    body: rootBody,
    activeElement: null,
    childNodes: [rootHtml],
    addEventListener(ev, fn) {
      if (!docListeners.has(ev)) docListeners.set(ev, []);
      docListeners.get(ev).push(fn);
    },
    removeEventListener(ev, fn) {
      const arr = docListeners.get(ev);
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    },
    querySelectorAll(sel) {
      return rootHtml.querySelectorAll(sel);
    },
    createTreeWalker(root) {
      const items = collectWalkNodes(root);
      let i = 0;
      return { nextNode: () => items[i++] || null };
    },
  };

  let fakeNow = 1000;
  const sandbox = {
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_NODE: 9, DOCUMENT_FRAGMENT_NODE: 11 },
    NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1 },
    MutationObserver: class {
      constructor(cb) { observerCb = cb; }
      observe(_target, opts) { observedOptions = opts; }
      disconnect() {}
    },
    document: fakeDoc,
    console,
    Date: { now: () => (fakeNow += 200) },
    Array, Map, Set, RegExp, Object, String, Math,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: (fn) => {
      pendingTimers.push(fn);
      return pendingTimers.length;
    },
    clearTimeout: () => {},
    requestAnimationFrame: (fn) => pendingTimers.push(fn),
    addEventListener: () => {},
  };
  sandbox.window = sandbox;

  return {
    rootBody,
    fakeDoc,
    sandbox,
    makeEl,
    makeText,
    getObserver: () => ({ cb: observerCb, options: observedOptions }),
    dispatchPointerEnter(target) {
      for (const fn of docListeners.get("pointerenter") || []) {
        fn({ target });
      }
      while (pendingTimers.length > 0) {
        const fn = pendingTimers.shift();
        fn();
      }
    },
    flushAllTimers() {
      while (pendingTimers.length > 0) {
        const fn = pendingTimers.shift();
        fn();
      }
    },
  };
}

test("Antigravity 斜杠命令全面汉化：词典命中、命令名护栏、推荐卡片解封、模糊高亮与动态模板无碰撞", async () => {
  const domCode = await read("resources/antigravity/dom-translator.js");
  const env = createDomTranslatorSandbox();
  const { rootBody, makeEl, makeText } = env;

  // (a) 代表性系统斜杠命令描述与新增内置技能完整描述
  const descCases = [
    ["plan", "Plan carefully before executing a task.", "在执行任务前进行周密规划。"],
    ["compact", "Compact the conversation now (summarize history to free up the context window).", "立即压缩当前对话（总结历史记录以释放上下文窗口）。"],
    ["computer", "Invoke a computer-use agent to operate apps on this Mac.", "调用桌面操控智能体操作此 Mac 上的应用程序。"],
    ["browser-vision", "[Teamfood] Invoke a browser with computer-use tools only with experimental model.", "[内部测试] 仅使用实验性模型与桌面操控工具调用浏览器。"],
    ["deepagent", "Experimental. Invoke the deep agent to plan, build, verify complex coding tasks.", "实验性功能。调用深度智能体来规划、构建并验证复杂编程任务。"],
    ["review-agent", "Experimental. Invoke the review agent to audit code changes, surface bugs, and verify correctness.", "实验性功能。调用审查智能体审计代码变更、排查缺陷并验证正确性。"],
    ["btw", "Ask a quick question without interrupting the main conversation.", "在不打断主会话的情况下快速提问。"],
    ["automation", 'Interactive guide to design and create a scheduled background automation. Use this skill when the user wants to create an automated or recurring scheduled task (e.g. "summarize my emails every morning", "every Monday send me a to-do list"). Also triggered by the /automation slash command.', "设计并创建后台定时自动化任务的交互式指南。当用户希望创建自动或周期性执行的定时任务（例如“每天早上汇总我的邮件”、“每周一发送待办清单”）时使用此技能，也可通过 /automation Slash Command触发。"],
    ["plugin", "How to manage and create plugins — namespaced bundles of skills, agents, rules, MCP servers and hooks that install, enable and disable as a single unit. Use this skill when the user wants to enable, disable, install or uninstall a plugin, when they want to create a new plugin, or when a new customization should be packaged into a plugin rather than left loose. Also triggered by the /plugin slash command. Don't use for the underlying customization system itself — discovery roots, loading priority, or authoring a standalone skill, agent, rule, hook or MCP server outside a plugin; see the customizations guide skill for those.", "管理与创建插件的完整指南——插件是将技能、Agent、规则、MCP 服务与 Hook 打包在命名空间下的组合包，可作为整体安装、启用或禁用。当用户需要管理或创建插件时使用此技能（也可通过 /plugin Slash Command触发）。"],
    ["migrate-workflows", "Automatically migrate legacy workflows to modern skills across global and workspace configurations. Scans for existing workflows, creates target SKILL.md files, and safely archives old workflow files.", "在全局和工作区配置中自动将旧版工作流 (Workflows) 迁移为现代技能 (Skills)。自动扫描现有工作流、创建目标 SKILL.md 文件并安全归档旧工作流文件。"],
    ["agy-customizations", "Comprehensive guide and reference for the Antigravity Customization System. Use to explain how customizations work, their loading priority, discovery mechanisms, and to guide the creation of skills, rules, plugins, hooks, and MCP servers.", "Antigravity 自定义扩展系统的完整指南与参考文档。用于说明各类自定义扩展的工作原理、加载优先级与发现机制，并指导创建技能、规则、插件、钩子与 MCP 服务。"],
    ["mcp-app-development", "Build, package, and debug MCP Apps for Antigravity: MCP server tools whose results render as interactive UI in the conversation, in the side pane, or full-page from the sidebar. Use when adding a UI to an MCP tool, building or theming the app itself, packaging it as a plugin, or debugging an app that doesn't render or behave as expected.", "为 Antigravity 构建、打包并调试 MCP 应用：这类 MCP 服务工具的结果可在对话中、侧边面板或左侧边栏全页中渲染为交互式界面。适用于为 MCP 工具添加交互界面、开发或适配应用主题、打包为插件，或排查应用无法渲染及行为异常的问题。"],
    ["migrate-agent-settings", "Migrates the user's MCP servers, skills, slash commands, subagents, and instruction files from other coding agents (Claude Code, Codex, Cursor, Gemini CLI) into one new Antigravity plugin. Use when the user wants to bring over, import, or migrate their setup or config from another agent or tool. Don't use for installing Marketplace plugins or authoring a new plugin from scratch (use the plugin skill).", "将用户在其他编程智能体（Claude Code、Codex、Cursor、Gemini CLI）中的 MCP 服务、技能、斜杠命令、子智能体及指令文件迁移整合为一个新的 Antigravity 插件。适用于希望从其他智能体或工具导入、迁移配置与工作环境的场景；不适用于安装扩展市场插件或从零创建新插件（请使用 plugin 技能）。"],
    ["workflow-banner-emdash", "Workflows are changing on October 19th—stay tuned for updates. You can use the agent to migrate your workflows.", "工作流功能将于 10 月 19 日调整，敬请关注更新。您可以使用智能体迁移现有工作流。"],
    ["gdocs-official", "Read, draft, and edit docs.", "读取、起草和编辑 Google 文档。"],
  ];
  const descNodes = descCases.map(([id, en, zh]) => ({
    id,
    zh,
    el: makeEl("span", { parent: rootBody, attrs: { "data-testid": "menu-option-description" }, text: en }),
  }));

  // (b) 命令名护栏：menu-option-label、hover-card-title 与技能芯片悬停卡（umb）标题严禁被翻成中文
  const slashMenuBox = makeEl("div", { parent: rootBody, attrs: { role: "listbox", "data-mention-menu": "" } });
  const protectedCmdNames = ["goal", "browser", "plan", "plugin", "automation", "grill-me", "btw", "compact", "learn", "boost", "migrate-workflows", "deepagent", "review-agent", "browser-vision", "Browser"];
  const labelNodes = protectedCmdNames.map((name) => ({
    name,
    el: makeEl("span", { parent: slashMenuBox, attrs: { "data-testid": "menu-option-label" }, text: name }),
  }));
  const hoverTitleNodes = ["goal", "browser", "plugin", "automation", "grill-me", "btw", "Goal"].map((name) => ({
    name,
    el: makeEl("span", { parent: rootBody, attrs: { "data-testid": "hover-card-title" }, text: name }),
  }));
  // 带模糊高亮拆分的命令名同样必须保持原样
  const fuzzyCmdLabel = makeEl("span", { parent: slashMenuBox, attrs: { "data-testid": "menu-option-label" } });
  makeEl("span", { parent: fuzzyCmdLabel, attrs: { "data-testid": "fuzzy-match-highlight" }, text: "go" });
  makeText("al", fuzzyCmdLabel);

  // 技能芯片悬停卡片（umb）：小写与大写开头的自定义技能名均受保护 + 右上角 "Open <name> skill" 按钮正常翻译
  const umbCard = makeEl("div", { parent: rootBody });
  const umbHeader = makeEl("div", { parent: umbCard });
  const umbTitle = makeEl("span", { parent: umbHeader, text: "learn" });
  const umbOpenBtn = makeEl("button", { parent: umbHeader, attrs: { "aria-label": "Open learn skill" }, text: "Open" });

  const umbUpperCard = makeEl("div", { parent: rootBody });
  const umbUpperHeader = makeEl("div", { parent: umbUpperCard });
  const umbUpperTitle = makeEl("span", { parent: umbUpperHeader, text: "Browser" });
  const umbUpperOpenBtn = makeEl("button", { parent: umbUpperHeader, attrs: { "aria-label": "Open Browser skill" }, text: "Open" });

  // (c) /plugin 推荐卡片解封 vs 普通自定义扩展卡片（含实机 T4 按钮名称槽结构）隔离
  const suggestionWrapper = makeEl("div", { parent: rootBody, attrs: { "data-testid": "plugin-suggestion-card" } });
  const suggestionCard = makeEl("div", { parent: suggestionWrapper, attrs: { "data-testid": "customization-card" } });
  const sugStatus = makeEl("p", { parent: suggestionCard, text: "Disabled. Open the plugin page to finish setup." });
  const sugSignHint = makeEl("p", { parent: suggestionCard, text: "Sign in to finish setting up this plugin." });
  const sugBadge = makeEl("span", { parent: suggestionCard, text: "Local only" });
  const sugNeedLogin = makeEl("span", { parent: suggestionCard, text: "Sign in needed" });
  const sugBtn = makeEl("button", { parent: suggestionCard, text: "Sign in to Google Drive" });
  const sugCode = makeEl("code", { parent: suggestionCard, text: "antigravity-plugins-official/plugin/gdrive" });

  const normalCustCard = makeEl("div", { parent: rootBody, attrs: { "data-testid": "customization-card", "data-card-name": "Browser", role: "button" } });
  const custTitle = makeEl("h3", { parent: normalCustCard, text: "Browser" });
  const custNameSpan = makeEl("span", { parent: normalCustCard, attrs: { "data-testid": "customization-card-title" }, text: "Settings" });
  const custT4NameWrap = makeEl("div", { parent: normalCustCard, classes: ["font-medium", "text-foreground", "truncate"] });
  const custT4NameBtn = makeEl("button", { parent: custT4NameWrap, classes: ["text-left", "after:inset-0"], attrs: { type: "button" }, text: "Browser" });
  const custActionBtn = makeEl("button", { parent: normalCustCard, attrs: { type: "button" }, text: "Enable" });
  const custUserText = makeEl("p", { parent: normalCustCard, text: "My private custom skill prompt" });
  const custCode = makeEl("code", { parent: normalCustCard, text: "~/.gemini/config/skills/my-tool" });

  // 实机 T4 卡片（不带 data-card-name 时仍凭 font-medium truncate / after:inset-0 保护名称按钮与链接）
  const normalT4NoAttr = makeEl("div", { parent: rootBody, attrs: { "data-testid": "customization-card" } });
  const t4NoAttrWrap = makeEl("div", { parent: normalT4NoAttr, classes: ["font-medium", "text-foreground", "truncate"] });
  const t4NoAttrBtn = makeEl("button", { parent: t4NoAttrWrap, classes: ["after:inset-0"], text: "Settings" });

  // (d) 含 <span data-testid="fuzzy-match-highlight"> 拆分的斜杠命令描述、连续敲字局部更新与前导省略号切片
  const fuzzyDesc = makeEl("span", { parent: rootBody, attrs: { "data-testid": "menu-option-description" } });
  const fuzzyT0 = makeText("Plan carefully ", fuzzyDesc);
  const fuzzyH0Span = makeEl("span", { parent: fuzzyDesc, attrs: { "data-testid": "fuzzy-match-highlight" } });
  const fuzzyH0 = makeText("b", fuzzyH0Span);
  const fuzzyT1 = makeText("efore executing a task.", fuzzyDesc);

  const fuzzySlicedDesc = makeEl("span", { parent: rootBody, attrs: { "data-testid": "menu-option-description" } });
  makeText("…to plan, build, ", fuzzySlicedDesc);
  makeEl("span", { parent: fuzzySlicedDesc, attrs: { "data-testid": "fuzzy-match-highlight" }, text: "verify" });
  makeText(" complex coding tasks.", fuzzySlicedDesc);

  // (e) 动态正则无半英半中碰撞（含实机 D6 全部 Cron 变体）+ 单键快捷键 + 搜索空状态 + 复合内联节点 + aria-description
  const dynNodes = [
    ['Created automation "Daily Summary".', "已创建自动化任务“Daily Summary”。"],
    ["Daily at 9:00 AM", "每天 上午 9:00"],
    ["Daily at 9:00 AM and 5:00 PM", "每天 上午 9:00、下午 5:00"],
    ["Weekdays at 9:00 AM, 1:00 PM, and 5:00 PM", "工作日 上午 9:00、下午 1:00、下午 5:00"],
    ["Every 15 minutes on weekdays", "工作日每 15 分钟"],
    ["Every 15 minutes on Mon, Wed, and Fri", "周一、周三、周五每 15 分钟"],
    ["Every 2 hours on Mon, Wed, and Fri", "周一、周三、周五每 2 小时"],
    ["Every hour on weekdays", "工作日每小时"],
    ["Every hour, 9 AM to 5 PM, on weekdays", "工作日每小时（上午 9:00 至 下午 5:00）"],
    ["Next run today around 9:00 AM", "下次运行：今天 约 上午 9:00"],
    ["Today 9:00 AM", "今天 上午 9:00"],
    ["Triggered 11/25/2026, 9:00:00 AM", "触发时间：11/25/2026, 9:00:00 AM"],
    ["Plan, 2 of 5 steps done", "计划进度：已完成 2 / 5 步"],
    ["2/5 steps · 1 failed", "2/5 步 · 1 项失败"],
    ["2/5 steps. Hide plan", "2/5 步。隐藏计划"],
    ["Compacting · 1m 20s", "正在压缩上下文 · 1 分钟 20 秒"],
    ["Checkpoint #2 (Steps 0–15) (Intent Only)", "检查点 #2（步骤 0–15）（仅意图摘要）"],
    ["Credentials expire in 2d 3h. Refresh credentials to keep this automation running", "凭据将在 2 天 3 小时 后过期。请刷新凭据以保持该自动化任务正常运行"],
    ["Required to create: title, instructions", "创建前需填写：标题、指令"],
    ["Submit (↵)", "提交 (↵)"],
    ["Continue (Enter)", "继续 (Enter)"],
    ["Skip (Esc)", "跳过 (Esc)"],
    ["Skip (Esc), Skip All (Ctrl+Esc)", "跳过 (Esc)，全部跳过 (Ctrl+Esc)"],
    ["Cancel Questionnaire and Stop the Agent (Esc)", "取消问卷并停止 Agent (Esc)"],
    ["1 Help · 2 Side Questions", "1 条帮助 · 2 条旁注提问"],
    ["View 2 help items and 1 side question", "查看 2 条帮助和 1 条旁注提问"],
    ["From Swarm", "来自 Swarm"],
    ["From your workspace", "From your workspace"],
  ].map(([en, zh]) => ({ zh, el: makeEl("span", { parent: rootBody, text: en }) }));

  // 搜索空状态（有搜索词单段 + 无搜索词双段）
  const emptySearchP = makeEl("p", { parent: rootBody, attrs: { "data-testid": "sidecar-list-empty" }, text: "No automations match “daily”." });
  const emptyDefaultBox = makeEl("div", { parent: rootBody, attrs: { "data-testid": "sidecar-list-empty" } });
  const emptyDefaultP1 = makeEl("p", { parent: emptyDefaultBox, text: "No automations yet" });
  const emptyDefaultP2 = makeEl("p", { parent: emptyDefaultBox, text: "Run a prompt on a schedule, like a morning summary of yesterday's changes. Runs show up here." });

  // 复合内联节点：删除确认弹窗 + 自动化配置摘要行 + 含 <code> 的 /run-workflow 技能描述
  const delConfirm = makeEl("p", { parent: rootBody });
  makeText("Are you sure you want to delete ", delConfirm);
  makeEl("strong", { parent: delConfirm, text: "Daily Summary" });
  makeText("? This action cannot be undone.", delConfirm);

  const autoSummary = makeEl("div", { parent: rootBody });
  makeText("Runs ", autoSummary);
  makeEl("button", { parent: autoSummary, text: "Daily at 9:00 AM" });
  makeText(" in ", autoSummary);
  makeEl("button", { parent: autoSummary, text: "my-repo" });
  makeText(" with ", autoSummary);
  makeEl("button", { parent: autoSummary, text: "Flash" });
  makeText(" on this computer.", autoSummary);

  const runWorkflowMd = makeEl("p", { parent: rootBody });
  makeText("How to write and run a dynamic workflow script with the ", runWorkflowMd);
  makeEl("code", { parent: runWorkflowMd, text: "run_workflow" });
  makeText(" tool: a Python script that orchestrates many agents with ", runWorkflowMd);
  makeEl("code", { parent: runWorkflowMd, text: "agent" });
  makeText(", ", runWorkflowMd);
  makeEl("code", { parent: runWorkflowMd, text: "parallel" });
  makeText(", ", runWorkflowMd);
  makeEl("code", { parent: runWorkflowMd, text: "pipeline" });
  makeText(", and ", runWorkflowMd);
  makeEl("code", { parent: runWorkflowMd, text: "phase" });
  makeText(". Use when a task splits into many independent or staged pieces of agent work (fan out over files, modules, bugs, or review angles, then aggregate), or when the user asks for a workflow. Don't use for a single delegated task (use a subagent) or for legacy workflow files (see migrate-workflows).", runWorkflowMd);

  // aria-description 属性与按钮动作 aria-label
  const ariaDescTarget = makeEl("button", {
    parent: rootBody,
    attrs: {
      "aria-label": "Pause Daily Summary",
      "aria-description": "Creates a local automation that runs on this computer",
    },
    text: "Pause",
  });

  // 运行真实 dom-translator.js
  vm.runInNewContext(domCode, env.sandbox);

  // 验证 (a) 系统命令与内置技能完整描述
  for (const item of descNodes) {
    assert.equal(item.el.textContent, item.zh, `命令/技能描述 ${item.id} 应准确译出`);
  }

  // 验证 (b) 命令名护栏
  for (const item of labelNodes) {
    assert.equal(item.el.textContent, item.name, `menu-option-label 中的 ${item.name} 绝不可被误翻`);
  }
  for (const item of hoverTitleNodes) {
    assert.equal(item.el.textContent, item.name, `hover-card-title 中的 ${item.name} 绝不可被误翻`);
  }
  assert.equal(fuzzyCmdLabel.textContent, "goal", "带模糊高亮的斜杠命令名绝不可被误翻");
  assert.equal(umbTitle.textContent, "learn", "技能悬停卡标题命令名绝不可被误翻");
  assert.equal(umbOpenBtn.getAttribute("aria-label"), "打开 learn 技能");
  assert.equal(umbUpperTitle.textContent, "Browser", "大写开头的技能悬停卡标题同样必须受保护");
  assert.equal(umbUpperOpenBtn.getAttribute("aria-label"), "打开 Browser 技能");

  // 验证 (c) 推荐卡片解封 vs 普通自定义扩展隔离（含实机 T4 按钮名称槽）
  assert.equal(sugStatus.textContent, "已禁用。请打开插件页面以完成配置。");
  assert.equal(sugSignHint.textContent, "请登录以完成此插件的配置。");
  assert.equal(sugBadge.textContent, "仅限本地");
  assert.equal(sugNeedLogin.textContent, "需要登录");
  assert.equal(sugBtn.textContent, "登录 Google Drive");
  assert.equal(sugCode.textContent, "antigravity-plugins-official/plugin/gdrive", "推荐卡片内代码块仍须隔离");

  assert.equal(custTitle.textContent, "Browser", "普通自定义扩展卡片标题必须隔离");
  assert.equal(custNameSpan.textContent, "Settings", "普通自定义扩展卡片名称节点必须隔离");
  assert.equal(custT4NameBtn.textContent, "Browser", "实机 T4 按钮形式的扩展名绝不可被误翻");
  assert.equal(t4NoAttrBtn.textContent, "Settings", "无 data-card-name 的 T4 标题按钮同样绝不可被误翻");
  assert.equal(custActionBtn.textContent, "启用", "普通扩展卡片内的功能操作按钮仍应正常翻译");
  assert.equal(custUserText.textContent, "My private custom skill prompt", "普通自定义扩展用户文本必须隔离");
  assert.equal(custCode.textContent, "~/.gemini/config/skills/my-tool", "普通自定义扩展路径代码必须隔离");

  // 验证 (d) 模糊搜索高亮拆分描述、连续敲字 React 局部更新与前导省略号切片
  assert.equal(fuzzyDesc.textContent, "在执行任务前进行周密规划。", "被 fuzzy-match-highlight 拆分的描述应完整译为中文");
  assert.equal(fuzzySlicedDesc.textContent, "实验性功能。调用深度智能体来规划、构建并验证复杂编程任务。", "带前导省略号切片的长描述应准确还原并翻译");

  // 模拟 React 连续敲字（"b" -> "be"）：React 因 t0 未变跳过 t0，仅改写 h0="be" 与 t1="fore executing a task."
  const obs = env.getObserver();
  fuzzyH0.nodeValue = "be";
  fuzzyT1.nodeValue = "fore executing a task.";
  obs.cb([
    { type: "characterData", target: fuzzyH0 },
    { type: "characterData", target: fuzzyT1 },
  ]);
  env.flushAllTimers();
  assert.equal(fuzzyDesc.textContent, "在执行任务前进行周密规划。", "连续敲字局部更新不得拼出半中半英残骸");

  // 模拟高亮 span 内部 childList 替换且 React 跳过 t1（t1 仍为空串）并切到未收录文本，必须完整还原尾段原文
  fuzzyT0.nodeValue = "Custom prefix ";
  fuzzyH0Span.childNodes = [];
  const fuzzyH0New = makeText("be", fuzzyH0Span);
  obs.cb([
    { type: "characterData", target: fuzzyT0 },
    { type: "childList", target: fuzzyH0Span, addedNodes: [fuzzyH0New] },
  ]);
  env.flushAllTimers();
  assert.equal(fuzzyDesc.textContent, "Custom prefix before executing a task.", "未命中词典回退时不得丢弃上次清空的尾段原文");

  // 验证 (e) 动态模板、单键快捷键、空状态、复合内联与属性监听
  for (const item of dynNodes) {
    assert.equal(item.el.textContent, item.zh);
  }
  assert.equal(emptySearchP.textContent, "没有与“daily”匹配的自动化任务。");
  assert.equal(emptyDefaultP1.textContent, "暂无自动化任务");
  assert.equal(emptyDefaultP2.textContent, "按预设计划运行提示词，例如在早晨汇总昨日的代码变更。运行记录将显示在此处。");

  assert.equal(delConfirm.textContent, "确定要删除 Daily Summary 吗？此操作无法撤销。");
  assert.equal(autoSummary.textContent, "运行计划：每天 上午 9:00，所在项目：my-repo，使用模型：Flash（在此计算机上运行）。");
  assert.match(runWorkflowMd.textContent, /^如何使用 run_workflow 工具编写和运行动态工作流脚本/);

  assert.equal(ariaDescTarget.textContent, "暂停");
  assert.equal(ariaDescTarget.getAttribute("aria-label"), "暂停 Daily Summary");
  assert.equal(ariaDescTarget.getAttribute("aria-description"), "创建一个在此计算机上运行的本地自动化任务");

  // 验证 MutationObserver 监听 aria-description 属性动态更新
  assert.ok(obs.options.attributeFilter.includes("aria-description"), "MutationObserver attributeFilter 必须包含 aria-description");
  ariaDescTarget.setAttribute("aria-description", "Refresh all credentials");
  obs.cb([{ type: "attributes", target: ariaDescTarget, attributeName: "aria-description" }]);
  assert.equal(ariaDescTarget.getAttribute("aria-description"), "刷新全部凭据");

  // 验证 [data-mention-menu] 与 [role="listbox"] 浮层经 scanFloatingPortals 实时翻译且保护命令名
  const mentionPortal = makeEl("div", {
    parent: rootBody,
    attrs: { role: "listbox", "aria-label": "Mentions", "data-mention-menu": "" },
  });
  const portalCmdLabel = makeEl("span", { parent: mentionPortal, attrs: { "data-testid": "menu-option-label" }, text: "compact" });
  const portalCmdDesc = makeEl("span", {
    parent: mentionPortal,
    attrs: { "data-testid": "menu-option-description" },
    text: "Compact the conversation now (summarize history to free up the context window).",
  });
  env.dispatchPointerEnter(mentionPortal);
  assert.equal(portalCmdLabel.textContent, "compact", "浮层斜杠菜单命令名必须保持原样");
  assert.equal(portalCmdDesc.textContent, "立即压缩当前对话（总结历史记录以释放上下文窗口）。", "浮层斜杠菜单描述应由 scanFloatingPortals 实时翻译");
});
