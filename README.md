# zero-browser-toolkit

独立管理 Zero 浏览器插件与本地 bridge 的仓库。目标不是做一套通用浏览器自动化平台，而是先把 **页面读取、tab 管理、页面内 eval** 这三类能力做稳。

## Contents
- `browser-zero-extension/` Chrome Extension
- `browser-gui-bridge/` Bun server on macOS

## Current Capabilities
当前已支持：

- `getPageContext`：读取当前 tab 的结构化页面上下文
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

#### Current Warning Signals
- `login_wall_signals`
- `unsupported_page`
- `error_shell`
- `main_text_empty`
- `body_text_short`

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
