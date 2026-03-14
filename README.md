# zero-browser-toolkit

独立管理 Zero 浏览器插件与本地 bridge 的仓库。目标不是做一套通用浏览器自动化平台，而是先把 **页面读取、tab 管理、页面内 eval** 这三类能力做稳。

## Contents
- `browser-zero-extension/` Chrome Extension
- `browser-gui-bridge/` Bun server on macOS

## Current Capabilities
当前已支持：

- `getPageContext`：读取当前 tab 的结构化页面上下文
- `getAccessibilityTree`：获取当前 tab 的语义化无障碍树（Accessibility Tree）
- `listTabs`：列出当前浏览器所有 tab
- `selectTab`：切换到指定 tab
- `eval`：在当前 tab 执行 JavaScript expression

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
读取当前 active tab 的页面上下文。

默认返回的是适合直接给 LLM 使用的“页面概览”：
- 关键字段会内联返回
- 超长 `bodyText` / `mainText` / `html` / `mainHtml` 会缩略显示
- 完整页面内容始终保存在 `savedTo` 指向的文件里，供后续本地处理或定向读取

#### Request
```json
{
  "action": "getPageContext"
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
获取当前 active tab 的语义化无障碍树（Accessibility Tree）。

通过 Chrome DevTools Protocol 的 `Accessibility.getFullAXTree` 获取完整 AX 树，
格式化为 `[role] name = value` 的缩进文本。比原始 HTML 信噪比高一个数量级。

#### Request
```json
{
  "action": "getAccessibilityTree"
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

### `eval`
在当前 active tab 执行 JavaScript expression。

> 目前支持的是 **expression**，不是整段 statement block。

#### Request
```json
{
  "action": "eval",
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

## curl Examples

### 读取当前页上下文
```bash
curl -s http://127.0.0.1:4318/action \
  -H 'content-type: application/json' \
  -d '{"action":"getPageContext"}'
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
