import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import {
  loadConfig,
  assertSafeConfig,
  defaultChatRailHome,
  resolveRuntimeHome
} from '../src/config.js'

test('loads .env without external dotenv dependency', async t => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wa-config-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  await fs.promises.writeFile(path.join(dir, '.env'), 'PORT=4444\nWA_PROVIDER=fake\nALLOW_UNREGISTERED=true\n')
  const config = loadConfig({ cwd: dir, home: dir, overrides: { HOST: '127.0.0.1' } })
  assert.equal(config.port, 4444)
  assert.equal(config.provider, 'fake')
  assert.equal(config.allowUnregistered, true)
  assert.equal(config.runtimeHome, dir)
})

test('uses CHATRAIL_HOME when explicitly configured', async t => {
  const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wa-cwd-'))
  const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wa-home-'))
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))

  await fs.promises.writeFile(path.join(cwd, '.env'), 'PORT=1111\n')
  await fs.promises.writeFile(path.join(home, '.env'), 'PORT=5555\nWA_PROVIDER=fake\n')

  const resolved = resolveRuntimeHome({
    cwd,
    env: { CHATRAIL_HOME: home }
  })

  assert.equal(resolved, path.resolve(home))

  const previous = process.env.CHATRAIL_HOME
  process.env.CHATRAIL_HOME = home
  try {
    const config = loadConfig({ cwd })
    assert.equal(config.runtimeHome, path.resolve(home))
    assert.equal(config.port, 5555)
    assert.equal(config.provider, 'fake')
  } finally {
    if (previous === undefined) delete process.env.CHATRAIL_HOME
    else process.env.CHATRAIL_HOME = previous
  }
})

test('uses local ChatRail project .env before falling back to user home', async t => {
  const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wa-local-'))
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }))

  assert.equal(resolveRuntimeHome({ cwd, env: {} }), defaultChatRailHome())

  await fs.promises.writeFile(path.join(cwd, '.env'), 'PORT=4444\n')
  assert.equal(resolveRuntimeHome({ cwd, env: {} }), defaultChatRailHome())

  await fs.promises.writeFile(
    path.join(cwd, 'package.json'),
    JSON.stringify({ name: '@pedroantonnio/chatrail' })
  )
  assert.equal(resolveRuntimeHome({ cwd, env: {} }), cwd)
})

test('refuses network exposure without API token', () => {
  assert.throws(() => assertSafeConfig({ host: '0.0.0.0', port: 3333, apiToken: '', provider: 'fake' }), /API_TOKEN/)
  assert.doesNotThrow(() => assertSafeConfig({ host: '0.0.0.0', port: 3333, apiToken: 'secret', provider: 'fake' }))
})

test('rejects invalid provider and port', () => {
  assert.throws(() => assertSafeConfig({ host: '127.0.0.1', port: 70000, apiToken: '', provider: 'fake' }), /PORT/)
  assert.throws(() => assertSafeConfig({ host: '127.0.0.1', port: 3333, apiToken: '', provider: 'bogus' }), /WA_PROVIDER/)
})