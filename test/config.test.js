import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { loadConfig, assertSafeConfig } from '../src/config.js'

test('loads .env without external dotenv dependency', async t => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wa-config-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  await fs.promises.writeFile(path.join(dir, '.env'), 'PORT=4444\nWA_PROVIDER=fake\nALLOW_UNREGISTERED=true\n')
  const config = loadConfig({ cwd: dir, overrides: { HOST: '127.0.0.1' } })
  assert.equal(config.port, 4444)
  assert.equal(config.provider, 'fake')
  assert.equal(config.allowUnregistered, true)
})

test('refuses network exposure without API token', () => {
  assert.throws(() => assertSafeConfig({ host: '0.0.0.0', port: 3333, apiToken: '', provider: 'fake' }), /API_TOKEN/)
  assert.doesNotThrow(() => assertSafeConfig({ host: '0.0.0.0', port: 3333, apiToken: 'secret', provider: 'fake' }))
})

test('rejects invalid provider and port', () => {
  assert.throws(() => assertSafeConfig({ host: '127.0.0.1', port: 70000, apiToken: '', provider: 'fake' }), /PORT/)
  assert.throws(() => assertSafeConfig({ host: '127.0.0.1', port: 3333, apiToken: '', provider: 'bogus' }), /WA_PROVIDER/)
})
