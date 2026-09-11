import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.resolve(process.cwd())
const roots = ['src', 'scripts', 'test']
const files = []
for (const rel of roots) {
  const dir = path.join(root, rel)
  if (!fs.existsSync(dir)) continue
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(full)
    }
  }
  walk(dir)
}

let failures = 0
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (result.status !== 0) {
    failures += 1
    console.error(`FAIL ${path.relative(root, file)}`)
    console.error(result.stderr || result.stdout)
  }
}

if (failures) {
  console.error(`Syntax check failed: ${failures}/${files.length}`)
  process.exit(1)
}
console.log(`Syntax check passed: ${files.length} JavaScript files`)
