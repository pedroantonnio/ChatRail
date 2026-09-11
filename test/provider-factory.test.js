import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { resolveProviderName, hasExistingBaileysSession } from '../src/provider-factory.js'

test('auto mode chooses wwebjs when no Baileys session exists', async t => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wa-provider-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  assert.equal(hasExistingBaileysSession(dir), false)
  assert.equal(resolveProviderName({ provider: 'auto', dataDir: dir }), 'wwebjs')
})

test('auto mode chooses Baileys when creds.json exists', async t => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wa-provider-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const auth = path.join(dir, 'baileys-auth')
  await fs.promises.mkdir(auth, { recursive: true })
  await fs.promises.writeFile(path.join(auth, 'creds.json'), '{}')
  assert.equal(hasExistingBaileysSession(dir), true)
  assert.equal(resolveProviderName({ provider: 'auto', dataDir: dir }), 'baileys')
})
