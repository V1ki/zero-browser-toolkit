# zero-browser-toolkit

独立管理 Zero 浏览器插件与本地 bridge 的仓库。

## Contents
- `browser-zero-extension/` Chrome Extension
- `browser-gui-bridge/` Bun server on macOS

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
