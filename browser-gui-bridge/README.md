# browser-gui-bridge

一个给 Zero Browser Toolkit 用的最小 macOS 浏览器 GUI bridge。

当前能力：
- `getFrontBrowserInfo`：读取前台浏览器当前 tab 的标题和 URL（默认 Google Chrome）
- `openUrl`：在浏览器中打开新 tab
- `copySelection`：激活浏览器后触发系统级 `Cmd+C`
- `getClipboardText`：读取剪贴板文本
- `screenshotFrontWindow`：对前台浏览器窗口区域截图，并保存到 bridge 输出目录
- `saveContext`：将标题、URL、剪贴板、截图路径、窗口 bounds 和时间戳写入 `latest-context.json`
- `captureContext`：先尝试复制当前选区，再保存完整上下文到 `latest-context.json`
- `POST /page-context`：接收浏览器插件直接发送的页面正文、选区和 HTML，并保存到 `latest-page-context.json`
- `POST /action { "action": "getPageContext" }`：返回适合直接放进 LLM 的页面概览，同时把完整页面保存在 `latest-page-context.json`

> 这是 GUI/Automation 兜底方案，不是 DOM 级自动化。

## 运行

```bash
cd browser-gui-bridge
bun install
bun run src/server.ts
```

默认监听：

- `http://127.0.0.1:4318`

## API

### Health

```bash
curl http://127.0.0.1:4318/health
```

### 获取当前 tab 信息

```bash
curl -s http://127.0.0.1:4318/action \
  -H 'content-type: application/json' \
  -d '{"action":"getFrontBrowserInfo"}'
```

### 打开 URL

```bash
curl -s http://127.0.0.1:4318/action \
  -H 'content-type: application/json' \
  -d '{"action":"openUrl","url":"https://example.com"}'
```

### 复制当前选区

```bash
curl -s http://127.0.0.1:4318/action \
  -H 'content-type: application/json' \
  -d '{"action":"copySelection"}'
```

### 读取剪贴板

```bash
curl -s http://127.0.0.1:4318/action \
  -H 'content-type: application/json' \
  -d '{"action":"getClipboardText"}'
```

### 截图前台浏览器窗口

```bash
curl -s http://127.0.0.1:4318/action \
  -H 'content-type: application/json' \
  -d '{"action":"screenshotFrontWindow"}'
```

### 保存当前上下文到 JSON

```bash
curl -s http://127.0.0.1:4318/action \
  -H 'content-type: application/json' \
  -d '{"action":"saveContext"}'
```

### 尝试复制选区并保存完整上下文

```bash
curl -s http://127.0.0.1:4318/action \
  -H 'content-type: application/json' \
  -d '{"action":"captureContext"}'
```

输出文件默认写到：

- `/tmp/zero-browser-toolkit/browser-gui-bridge/latest-context.json`
- `/tmp/zero-browser-toolkit/browser-gui-bridge/latest-page-context.json`

也可通过环境变量覆盖：

```bash
export BROWSER_GUI_BRIDGE_SHARED_DIR="$HOME/.zero-browser-toolkit/browser-gui-bridge"
```

## macOS 权限

第一次使用可能需要授予：
- Accessibility
- Automation（允许控制 Google Chrome / System Events）
- Screen Recording（如果使用窗口截图）

## 可扩展方向

这套 bridge 很适合加入 **截图 + 大模型识别** 作为兜底：

1. 通过系统截图或浏览器窗口截图拿到当前可见区域
2. 将图片交给多模态模型做：
   - 页面理解
   - 按钮/输入框定位
   - 错误状态识别
   - UI 文本提取（OCR）
3. 再由 bridge 执行：
   - 点击
   - 快捷键
   - 打开 URL
   - 复制内容

适用场景：
- CDP 不稳定
- 页面 DOM 难以可靠获取
- 只需要“看到并理解当前屏幕内容”

不适用场景：
- 高精度、长流程、强确定性的网页自动化

## 限制

- 当前优先支持 Google Chrome
- `copySelection` 会先激活浏览器，但仍依赖页面中确实存在可复制的选区
- 这是系统 GUI 自动化，不保证对复杂网页稳定
- 如果后续加入截图识别，仍需要处理 Screen Recording 权限与视觉定位误差
