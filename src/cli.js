import { loadConfig, parseCliArgs } from './config.js'
import { createApp } from './app.js'
import { resolveProviderName } from './provider-factory.js'
import { SERVICE_VERSION } from './service.js'

const overrides = parseCliArgs()
const config = loadConfig({ overrides })
const selected = resolveProviderName(config)

console.log(`ChatRail v${SERVICE_VERSION}`)
console.log(`Provider: ${selected}`)
console.log(`Data: ${config.dataDir}`)
console.log(`API: http://${config.host}:${config.port}`)
console.log(`Recipient allowlist: ${config.allowUnregistered ? 'OFF' : 'ON'}`)

if (selected === 'baileys') {
  console.log('Note: current upstream Baileys has reported fresh-pairing regressions; auto mode uses it only when an existing Baileys auth session is present.')
}

const app = await createApp(config)

const shutdown = async signal => {
  console.log(`\n${signal}: stopping...`)
  try { await app.stop() } finally { process.exit(0) }
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

try {
  await app.start()
  console.log('HTTP API listening. Use GET /status for connection state.')
} catch (error) {
  console.error(error)
  process.exit(1)
}
