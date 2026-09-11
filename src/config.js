import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseBoolean } from './normalize.js'

function parseEnvFile(text) {
  const result = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const idx = line.indexOf('=')
    if (idx < 0) continue
    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    result[key] = value
  }
  return result
}

export function loadEnvFile(cwd = process.cwd()) {
  const envPath = path.join(cwd, '.env')
  if (!fs.existsSync(envPath)) return {}
  return parseEnvFile(fs.readFileSync(envPath, 'utf8'))
}

export function loadConfig({ cwd = process.cwd(), overrides = {} } = {}) {
  const fileEnv = loadEnvFile(cwd)
  const env = { ...fileEnv, ...process.env, ...overrides }
  const dataDir = path.resolve(cwd, env.DATA_DIR || './data')

  return {
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT || 3333),
    provider: String(env.WA_PROVIDER || 'auto').toLowerCase(),
    dataDir,
    defaultCountryCode: String(env.DEFAULT_COUNTRY_CODE || ''),
    allowUnregistered: parseBoolean(env.ALLOW_UNREGISTERED, false),
    allowGroups: parseBoolean(env.ALLOW_GROUPS, false),
    dedupeWindowHours: Math.max(1, Number(env.DEDUPE_WINDOW_HOURS || 720)),
    apiToken: env.API_TOKEN || '',
    headless: parseBoolean(env.HEADLESS, true),
    logLevel: env.LOG_LEVEL || 'info',
    cwd
  }
}

export function parseCliArgs(argv = process.argv.slice(2)) {
  const out = {}
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue
    const [key, value = 'true'] = arg.slice(2).split('=', 2)
    if (key === 'provider') out.WA_PROVIDER = value
    if (key === 'port') out.PORT = value
    if (key === 'host') out.HOST = value
    if (key === 'headless') out.HEADLESS = value
    if (key === 'data-dir') out.DATA_DIR = value
  }
  return out
}

export const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

export function assertSafeConfig(config) {
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new Error(`Invalid PORT: ${config.port}`)
  }
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(config.host)
  if (!loopback && !config.apiToken) {
    throw new Error('Refusing to bind to a non-loopback HOST without API_TOKEN')
  }
  if (!['auto', 'wwebjs', 'baileys', 'fake'].includes(config.provider)) {
    throw new Error(`Invalid WA_PROVIDER: ${config.provider}`)
  }
  return config
}
