import fs from 'node:fs'
import path from 'node:path'
import { FakeProvider } from './providers/fake.js'
import { WWebJSProvider } from './providers/wwebjs.js'
import { BaileysProvider } from './providers/baileys.js'

export function hasExistingBaileysSession(dataDir) {
  return fs.existsSync(path.join(dataDir, 'baileys-auth', 'creds.json'))
}

export function resolveProviderName(config) {
  if (config.provider !== 'auto') return config.provider
  return hasExistingBaileysSession(config.dataDir) ? 'baileys' : 'wwebjs'
}

export function createProvider(config, logger) {
  const name = resolveProviderName(config)
  const shared = {
    logger: logger.child({ module: name }),
    dataDir: config.dataDir,
    headless: config.headless,
    allowGroups: config.allowGroups
  }

  if (name === 'fake') return new FakeProvider(shared)
  if (name === 'wwebjs') return new WWebJSProvider(shared)
  if (name === 'baileys') return new BaileysProvider(shared)
  throw new Error(`Unknown WA_PROVIDER: ${name}`)
}
