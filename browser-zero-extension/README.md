# Zero Browser Context Extension

最小 Chrome Extension，用来把当前页面内容直接发送到本地 Zero bridge，并轮询接收本地命令。

## 目录

- `manifest.json`
- `background.js`
- `popup.html`
- `popup.js`

## 功能

### Popup 手动发送当前页面
点击扩展按钮后会采集当前页面：
- `title`
- `url`
- `selectionText`
- `bodyText`
- `html`

并 POST 到：
- `http://127.0.0.1:4318/page-context`

### Background 自动轮询命令
插件会轮询：
- `GET http://127.0.0.1:4318/extension/next-command`

并执行这些命令：
- `openUrl`
- `getPageText`
- `scrollBy`

执行完成后 POST 回：
- `POST http://127.0.0.1:4318/extension/command-result`

## 安装

Chrome 中打开：
- `chrome://extensions`

然后：
- 开启 Developer mode
- 选择 `Load unpacked`
- 载入目录：
  - `<repo>/browser-zero-extension`

如果已经加载过旧版，需要点击一次刷新。

## 发送命令示例

### 打开网页

```bash
curl -s http://127.0.0.1:4318/extension/enqueue-command \
  -H 'content-type: application/json' \
  -d '{"type":"openUrl","payload":{"url":"https://example.com"}}'
```

### 读取当前页文本

```bash
curl -s http://127.0.0.1:4318/extension/enqueue-command \
  -H 'content-type: application/json' \
  -d '{"type":"getPageText"}'
```

### 向下滚动

```bash
curl -s http://127.0.0.1:4318/extension/enqueue-command \
  -H 'content-type: application/json' \
  -d '{"type":"scrollBy","payload":{"y":1200}}'
```

### 查看最近执行结果

```bash
curl -s http://127.0.0.1:4318/extension/latest-result
```
