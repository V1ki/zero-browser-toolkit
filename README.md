# zero-browser-toolkit

独立管理 Zero 浏览器插件与本地 bridge 的仓库。目标不是做一套通用浏览器自动化平台，而是先把 **页面读取、tab 管理、页面内 eval** 这三类能力做稳。

## Contents
- `browser-zero-extension/` Chrome Extension
- `browser-gui-bridge/` Bun server on macOS

## Current Capabilities
当前已支持：

- `getPageContext`：读取页面的结构化上下文（支持 `tabId` 指定目标 tab）
- `getAccessibilityTree`：获取语义化无障碍树（支持 `tabId`）
- `listTabs`：列出当前浏览器所有 tab
- `selectTab`：切换到指定 tab 并聚焦窗口
- `closeTab` / `closeTabs`：关闭单个或多个 tab
- `eval`：在页面中执行 JavaScript expression（支持 `tabId`）
- `click` / `input` / `getElements`：页面交互操作（支持 `tabId`）
- `screenshot`：截取页面（支持 `tabId`、CSS `selector` 元素裁剪、`rect` 矩形裁剪、`padding`，跨平台）
- `reloadExtension`：触发扩展自身重载，方便热更新 background.js

### v0.4.1 新增
- 所有 tab 依赖操作支持可选 `tabId` 参数，可直接操作指定 tab 无需先 `selectTab`
- 自动检测并唤醒被 Chrome 休眠（discarded）的 tab

### v0.6.0 新增
- `screenshot` 元素裁剪：传 `selector` 自动定位、scrollIntoView 后裁剪到元素 bounding rect
- `screenshot` 长截图：当目标元素超过 viewport 高度时，bridge 端自动滚动捕获多段并用 pngjs 拼接 → 跨平台纯 JS，无 sips/ImageMagick 依赖
- `screenshot` 支持 `mode: "cdp"`：通过 chrome.debugger + `Page.captureScreenshot` 截取**非可见 tab**，不切换用户当前焦点；支持 `captureBeyondViewport` 一次成像
- `screenshot` 支持 `mode: "visible"` + `restoreActive: true`：截完恢复原 active tab
- `reloadExtension` 命令：bridge 可触发 extension 自身 `chrome.runtime.reload()`，避免每次改 background.js 都要手动 reload

### v0.6.15 关键修复（头像/图片渲染）
- X.com 等 SPA 把头像放在**opacity:0 的 `<img>` + sibling div 的 `background-image`**上；后者在截图时经常被画成黑色
- 新默认行为 `forceImgOpacity:true`：截图前自动克隆所有可见 `<img>` 到 `<body>` 顶层，用 `position:fixed` 钉在原 bounding rect 上，`z-index: 2147483647`，`border-radius` 继承父元素。React 不会 reconcile 这些注入元素，所以不会被清掉
- CDP 模式**默认关闭** `Emulation.setDeviceMetricsOverride`：X 在 override 状态下会 reflow/remount 整片内容，把 overlay 也清掉了。关掉 override 后 captureBeyondViewport 一样能拿到全 article
- 最终结果：CDP 后台 4 秒完成，1244×2960 主帖完整截图，含 Karpathy 头像 + 用户名 + 5 段正文 + 时间戳和浏览数

### v0.6.1 ~ v0.6.11 增量改进
- CDP 路径**一站式**：selector 测量 + capture 都在同一次 `chrome.debugger.attach` 会话中完成，不再依赖外部 `chrome.scripting` eval。彻底消除虚拟滚动列表（react-virtualized / X.com 等）下「测量看到的 DOM」与「截图看到的 DOM」不一致的竞态
- `screenshot` 新增 `reload: true`：CDP 会话内通过 `Page.reload` 触发目标 tab reload，并等待 `Page.loadEventFired`——在**完全后台、不切 tab、不切 window**的前提下完成。专门解决"目标 tab 历史滚动状态错误"的场景
- `screenshot` 新增 `waitMs` / `evalBefore`：reload 后追加等待 / 注入预处理 JS（例如 `window.scrollTo(0,0)`）
- `screenshot` 新增 `deviceMetrics`：CDP 路径**默认**用 `Emulation.setDeviceMetricsOverride` 强制 1512×3000@2x 桌面布局
  - 修复 1：X.com 等响应式站点在后台 tab 上被收缩成窄列
  - 修复 2：**SPA lazy-render** 问题——viewport 高度大到能容下整个目标元素时，IntersectionObserver 一次触发所有内容渲染，**头像/按钮/图片**全部加载，不再是透明占位符
  - 修复 3：单段截图，**彻底没有拼接痕迹**
- CDP 路径每次调用前自动尝试 `chrome.debugger.detach`，避免上次失败留下的悬挂 attach
- 验证：3 个 Chrome window 并存，目标 tab 在第三个 window 且 `active=false` → CDP 一站式 reload + measure + capture，输出 1244×2960 完整主帖截图（含头像 + 用户名 + 5 段正文 + 互动按钮），全过程 ~15 秒，3 个 window 的 active tab 全部纹丝未动 ✅

## Architecture
整体链路：

1. 本地运行 `browser-gui-bridge`
2. Chrome 安装 `browser-zero-extension`
3. bridge 通过本地 HTTP 维护 command queue
4. extension 轮询 command queue，执行浏览器动作并回传结果

bridge 默认监听：

- `http://127.0.0.1:4318`

## Setup

### 1. 安装依赖
```bash
cd browser-toolkit
bun install
```

### 2. 启动 bridge
```bash
cd browser-toolkit
bun run --cwd browser-gui-bridge dev
```

健康检查：
```bash
curl http://127.0.0.1:4318/health
```

### 3. 安装 Chrome Extension
在 Chrome 打开：

- `chrome://extensions`
- 开启 `Developer mode`
- 点击 `Load unpacked`
- 选择 `browser-zero-extension/`

安装后 extension 会定时轮询本地 bridge。

## API Usage
统一入口：

- `POST /action`

请求体为 JSON。

---

### `getPageContext`
读取页面上下文。支持可选 `tabId` 指定目标 tab，不传则操作当前 active tab。

默认返回的是适合直接给 LLM 使用的“页面概览”：
- 关键字段会内联返回
- 超长 `bodyText` / `mainText` / `html` / `mainHtml` 会缩略显示
- 完整页面内容始终保存在 `savedTo` 指向的文件里，供后续本地处理或定向读取
- 如果目标 tab 被 Chrome 休眠（discarded），会自动 reload 并等待加载完成

#### Request
```json
{
  "action": "getPageContext"
}
```

指定 tab：
```json
{
  "action": "getPageContext",
  "tabId": 123
}
```

#### Response
示例：
```json
{
  "ok": true,
  "via": "extension-command-queue",
  "commandId": "cmd_xxx",
  "savedTo": "/tmp/zero-browser-toolkit/browser-gui-bridge/latest-page-context.json",
  "contentSizes": {
    "bodyTextChars": 16046,
    "htmlChars": 618509
  },
  "pageContext": {
    "ok": true,
    "title": "Example",
    "url": "https://example.com",
    "readyState": "complete",
    "bodyText": "...",
    "mainText": "...",
    "html": "...",
    "mainHtml": "...",
    "links": [],
    "meta": {},
    "warnings": []
  }
}
```

#### Extracted Fields
- `title`
- `url`
- `readyState`
- `selectionText`
- `bodyText`
- `mainText`
- `html`
- `mainHtml`
- `links`
- `meta`
- `warnings`

建议工作流：
1. 先用 `getPageContext` 看 `warnings`、`contentSizes`、正文预览和 `savedTo`
2. 需要精确 DOM 数据时，再用 `eval`
3. 需要完整页面离线处理时，直接消费 `savedTo` 对应文件，不要把整页 HTML 原样打印回聊天

#### Current Warning Signals
- `login_wall_signals`
- `unsupported_page`
- `error_shell`
- `main_text_empty`
- `body_text_short`

---

### `getAccessibilityTree`
获取语义化无障碍树（Accessibility Tree）。支持可选 `tabId` 指定目标 tab。

通过 Chrome DevTools Protocol 的 `Accessibility.getFullAXTree` 获取完整 AX 树，
格式化为 `[role] name = value` 的缩进文本。比原始 HTML 信噪比高一个数量级。

#### Request
```json
{
  "action": "getAccessibilityTree"
}
```

指定 tab：
```json
{
  "action": "getAccessibilityTree",
  "tabId": 123
}
```

可选参数：
```json
{
  "action": "getAccessibilityTree",
  "compact": true,
  "maxDepth": 5
}
```

- `compact`（默认 `true`）：过滤 `InlineTextBox`、`none`、`generic` 等噪声节点
- `maxDepth`（默认 `0` = 不限）：限制树的最大深度

#### Response
```json
{
  "ok": true,
  "via": "extension-command-queue",
  "commandId": "cmd_xxx",
  "title": "Example",
  "url": "https://example.com",
  "savedTo": "/tmp/zero-browser-toolkit/browser-gui-bridge/latest-accessibility-tree.txt",
  "stats": {
    "totalNodes": 1234,
    "visibleNodes": 456,
    "treeChars": 28000
  },
  "tree": "[RootWebArea] Example\n  [heading] Welcome\n  [link] About\n  ..."
}
```

#### 输出格式示例
```
[RootWebArea] Example Page
  [navigation] Main
    [link] Home
    [link] About
    [link] Contact
  [main]
    [heading] Welcome
    [paragraph] This is the main content.
    [textbox] Search = ""
    [button] Submit
  [contentinfo] Footer
    [link] Privacy Policy
```

#### 使用建议
- 需要理解交互结构时用 `getAccessibilityTree`，需要提取正文内容时用 `getPageContext`
- 完整树可能很大，响应内联最多 8000 字符，完整内容在 `savedTo` 路径
- 结合 `eval` 做后续定向操作：先用 AX 树定位角色和名称，再用 `eval` 精确操作

---

### `listTabs`
列出当前浏览器中的所有 tab。

#### Request
```json
{
  "action": "listTabs"
}
```

#### Response
```json
{
  "ok": true,
  "tabs": [
    {
      "id": 123,
      "windowId": 1,
      "active": true,
      "title": "Example",
      "url": "https://example.com"
    }
  ],
  "activeTabId": 123,
  "activeWindowId": 1
}
```

---

### `selectTab`
切换到指定 tab，并聚焦对应 window。

#### Request
```json
{
  "action": "selectTab",
  "tabId": 123
}
```

#### Response
```json
{
  "ok": true,
  "tabId": 123,
  "windowId": 1,
  "title": "Example",
  "url": "https://example.com"
}
```

---

### `closeTab`
关闭单个 tab。`closeTabs` 的便捷别名。

#### Request
```json
{
  "action": "closeTab",
  "tabId": 123
}
```

#### Response
```json
{
  "ok": true,
  "closed": 1
}
```

---

### `closeTabs`
批量关闭多个 tab。

#### Request
```json
{
  "action": "closeTabs",
  "tabIds": [123, 456]
}
```

#### Response
```json
{
  "ok": true,
  "closed": 2
}
```

---

### `eval`
在页面中执行 JavaScript expression。支持可选 `tabId` 指定目标 tab，不传则操作当前 active tab。

> 目前支持的是 **expression**，不是整段 statement block。

#### Request
```json
{
  "action": "eval",
  "expression": "document.title"
}
```

指定 tab：
```json
{
  "action": "eval",
  "tabId": 123,
  "expression": "document.title"
}
```

#### Response
```json
{
  "ok": true,
  "tabId": 123,
  "windowId": 1,
  "value": "Example Domain"
}
```

#### Supported Examples
简单值：
```json
{
  "action": "eval",
  "expression": "document.title"
}
```

返回对象：
```json
{
  "action": "eval",
  "expression": "({ title: document.title, url: location.href })"
}
```

异步表达式：
```json
{
  "action": "eval",
  "expression": "(async () => { return document.body.innerText.slice(0, 500) })()"
}
```

#### Eval Warnings
- `eval_returned_undefined`
- `eval_value_stringified`

如果返回值无法直接 JSON 序列化，会自动退化为字符串。

---

## 指定 Tab 操作（v0.4.1+）

`getPageContext`、`eval`、`click`、`input`、`getElements`、`getAccessibilityTree` 均支持可选的 `tabId` 参数。

传入 `tabId` 后，命令直接在指定 tab 上执行，无需先 `selectTab`。在多窗口/多显示器环境下更可靠。

如果目标 tab 被 Chrome 休眠（discarded），会自动 reload 并等待页面加载完成（最多 15 秒）。

不传 `tabId` 时行为不变，仍操作当前活跃 tab。

**推荐工作流（多窗口环境）：**
1. `listTabs` 找到目标 tab 的 `tabId`
2. 直接用 `tabId` 调用 `getPageContext` 或 `eval`，无需 `selectTab`

```bash
# 直接读取指定 tab 的页面内容
curl -s http://127.0.0.1:4318/action \
  -H 'content-type: application/json' \
  -d '{"action":"getPageContext","tabId":123}'

# 直接在指定 tab 执行 JS
curl -s http://127.0.0.1:4318/action \
  -H 'content-type: application/json' \
  -d '{"action":"eval","tabId":123,"expression":"document.title"}'
```

---

## curl Examples

### 读取页面上下文
```bash
curl -s http://127.0.0.1:4318/action \
  -H 'content-type: application/json' \
  -d '{"action":"getPageContext"}'
```

### 读取指定 tab 的页面上下文
```bash
curl -s http://127.0.0.1:4318/action \
  -H 'content-type: application/json' \
  -d '{"action":"getPageContext","tabId":123}'
```

### 获取无障碍树
```bash
curl -s http://127.0.0.1:4318/action \
  -H 'content-type: application/json' \
  -d '{"action":"getAccessibilityTree"}'
```

### 列出所有 tab
```bash
curl -s http://127.0.0.1:4318/action \
  -H 'content-type: application/json' \
  -d '{"action":"listTabs"}'
```

### 切换 tab
```bash
curl -s http://127.0.0.1:4318/action \
  -H 'content-type: application/json' \
  -d '{"action":"selectTab","tabId":123}'
```

### 关闭单个 tab
```bash
curl -s http://127.0.0.1:4318/action \
  -H 'content-type: application/json' \
  -d '{"action":"closeTab","tabId":123}'
```

### 批量关闭多个 tab
```bash
curl -s http://127.0.0.1:4318/action \
  -H 'content-type: application/json' \
  -d '{"action":"closeTabs","tabIds":[123,456]}'
```

### 执行 eval
```bash
curl -s http://127.0.0.1:4318/action \
  -H 'content-type: application/json' \
  -d '{"action":"eval","expression":"document.title"}'
```

## Local Files
bridge 会把一些状态落到本地：

- `latest-context.json`
- `latest-page-context.json`
- `command-queue.json`
- `latest-command-result.json`

默认目录：
```bash
/tmp/zero-browser-toolkit/browser-gui-bridge
```

## Versioning
根目录 `package.json` 的 `version` 是唯一版本源。

同步版本：
```bash
cd browser-toolkit
node scripts/sync-version.mjs
```

升级版本：
```bash
bun run release:patch
bun run release:minor
bun run release:major
```

会自动同步到：
- `browser-zero-extension/manifest.json`
- `browser-gui-bridge/package.json`

## Validation
```bash
bun run check
```

## Suggested Git Flow
```bash
git init
git add .
git commit -m "init: zero browser toolkit"
```

然后添加 GitHub remote：
```bash
git remote add origin <your-github-repo-url>
git push -u origin main
```
