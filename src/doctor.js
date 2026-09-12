import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { loadConfig } from './config.js'
import { resolveProviderName, hasExistingBaileysSession } from './provider-factory.js'

const require = createRequire(import.meta.url)

export async function runDoctor({ config = loadConfig(), write = console.log } = {}) {
  const major = Number(process.versions.node.split('.')[0])
  let ok = true

  write('=== CHATRAIL DOCTOR ===')
  write(`Node: ${process.version} ${major >= 20 ? 'OK' : 'FAIL (requires >=20)'}`)
  if (major < 20) ok = false
  write(`Home: ${config.runtimeHome || config.cwd}`)
  write(`Host: ${config.host}`)
  write(`Port: ${config.port}`)
  write(`Data dir: ${config.dataDir}`)
  write(`Configured provider: ${config.provider}`)
  write(`Resolved provider: ${resolveProviderName(config)}`)
  write(`Existing Baileys session: ${hasExistingBaileysSession(config.dataDir)}`)
  write(`Recipient allowlist: ${config.allowUnregistered ? 'DISABLED' : 'ENABLED'}`)
  write(`API token: ${config.apiToken ? 'configured' : 'not configured (safe only because HOST defaults to 127.0.0.1)'}`)

  for (const dep of ['whatsapp-web.js', 'qrcode-terminal', '@whiskeysockets/baileys']) {
    try {
      if (dep === '@whiskeysockets/baileys') {
        await import(dep)
      } else {
        require.resolve(dep)
      }
      write(`Dependency ${dep}: OK`)
    } catch {
      write(`Dependency ${dep}: MISSING`)
      ok = false
    }
  }

  if (!fs.existsSync(config.dataDir)) {
    fs.mkdirSync(config.dataDir, { recursive: true })
    write('Data dir created: OK')
  }

  if (!['127.0.0.1', 'localhost', '::1'].includes(config.host) && !config.apiToken) {
    write('SECURITY FAIL: non-loopback HOST requires API_TOKEN')
    ok = false
  }

  write(ok ? 'DOCTOR PASS' : 'DOCTOR FAIL')
  return ok
}
