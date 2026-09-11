import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { loadConfig } from '../src/config.js'
import { resolveProviderName, hasExistingBaileysSession } from '../src/provider-factory.js'

const require = createRequire(import.meta.url)
const config = loadConfig()
const major = Number(process.versions.node.split('.')[0])
let ok = true

console.log('=== CHATRAIL DOCTOR ===')
console.log(`Node: ${process.version} ${major >= 20 ? 'OK' : 'FAIL (requires >=20)'}`)
if (major < 20) ok = false
console.log(`Host: ${config.host}`)
console.log(`Port: ${config.port}`)
console.log(`Data dir: ${config.dataDir}`)
console.log(`Configured provider: ${config.provider}`)
console.log(`Resolved provider: ${resolveProviderName(config)}`)
console.log(`Existing Baileys session: ${hasExistingBaileysSession(config.dataDir)}`)
console.log(`Recipient allowlist: ${config.allowUnregistered ? 'DISABLED' : 'ENABLED'}`)
console.log(`API token: ${config.apiToken ? 'configured' : 'not configured (safe only because HOST defaults to 127.0.0.1)'}`)

for (const dep of ['whatsapp-web.js', 'qrcode-terminal', '@whiskeysockets/baileys']) {
  try {
    if (dep === '@whiskeysockets/baileys') {
      await import(dep)
    } else {
      require.resolve(dep)
    }
    console.log(`Dependency ${dep}: OK`)
  } catch (error) {
    console.log(`Dependency ${dep}: MISSING`)
    ok = false
  }
}

if (!fs.existsSync(config.dataDir)) {
  fs.mkdirSync(config.dataDir, { recursive: true })
  console.log('Data dir created: OK')
}

if (config.host !== '127.0.0.1' && config.host !== 'localhost' && !config.apiToken) {
  console.log('SECURITY FAIL: non-loopback HOST requires API_TOKEN')
  ok = false
}

console.log(ok ? 'DOCTOR PASS' : 'DOCTOR FAIL')
process.exit(ok ? 0 : 1)
