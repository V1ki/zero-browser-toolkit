import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const rootPkgPath = join(root, 'package.json')
const bridgePkgPath = join(root, 'browser-gui-bridge', 'package.json')
const extensionManifestPath = join(root, 'browser-zero-extension', 'manifest.json')

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

const rootPkg = readJson(rootPkgPath)
const version = rootPkg.version
if (!version) {
  throw new Error('root package.json missing version')
}

const bridgePkg = readJson(bridgePkgPath)
bridgePkg.version = version
bridgePkg.private = true

const manifest = readJson(extensionManifestPath)
manifest.version = version

writeJson(bridgePkgPath, bridgePkg)
writeJson(extensionManifestPath, manifest)

console.log(JSON.stringify({
  ok: true,
  version,
  updated: [bridgePkgPath, extensionManifestPath],
}, null, 2))
