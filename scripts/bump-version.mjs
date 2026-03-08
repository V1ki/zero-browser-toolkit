import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const kind = process.argv[2]
if (!['patch', 'minor', 'major'].includes(kind)) {
  throw new Error('usage: node scripts/bump-version.mjs <patch|minor|major>')
}

const root = process.cwd()
const rootPkgPath = join(root, 'package.json')
const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'))
const current = String(rootPkg.version || '0.1.0')
const parts = current.split('.').map(Number)
if (parts.length !== 3 || parts.some(Number.isNaN)) {
  throw new Error(`invalid semver: ${current}`)
}

if (kind === 'patch') parts[2] += 1
if (kind === 'minor') { parts[1] += 1; parts[2] = 0 }
if (kind === 'major') { parts[0] += 1; parts[1] = 0; parts[2] = 0 }

rootPkg.version = parts.join('.')
writeFileSync(rootPkgPath, `${JSON.stringify(rootPkg, null, 2)}\n`)

const sync = spawnSync(process.execPath, [join(root, 'scripts', 'sync-version.mjs')], {
  stdio: 'inherit',
})
if (sync.status !== 0) process.exit(sync.status || 1)

console.log(JSON.stringify({ ok: true, from: current, to: rootPkg.version, kind }, null, 2))
