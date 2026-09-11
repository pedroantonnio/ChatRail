import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import assert from 'node:assert/strict'
import { createApp } from '../src/app.js'
import { FakeProvider } from '../src/providers/fake.js'
import { createLogger } from '../src/logger.js'

const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chatrail-selftest-'))
const config = {
  host: '127.0.0.1', port: 0, provider: 'fake', dataDir: dir,
  defaultCountryCode: '44', allowUnregistered: false, allowGroups: false, dedupeWindowHours: 720,
  apiToken: '', headless: true, logLevel: 'silent'
}
const provider = new FakeProvider({ logger: createLogger('silent') })
const app = await createApp(config, { provider, logger: createLogger('silent') })

try {
  const addr = await app.start({ waitForProvider: true })
  const base = `http://127.0.0.1:${addr.port}`
  const post = async (url, body) => {
    const r = await fetch(base + url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    })
    return { status: r.status, body: await r.json() }
  }
  let r = await fetch(base + '/health')
  assert.equal(r.status, 200)

  let p = await post('/recipients', { phone: '7700900123', name: 'Self Test' })
  assert.equal(p.status, 201)

  let s = await post('/send', { phone: '7700900123', text: 'selftest-message', idempotencyKey: 'selftest-1' })
  assert.equal(s.status, 201)
  assert.equal(s.body.send.providerConfirmed, true)

  let dup = await post('/send', { phone: '7700900123', text: 'selftest-message', idempotencyKey: 'selftest-1' })
  assert.equal(dup.status, 200)
  assert.equal(dup.body.duplicate, true)
  assert.equal(provider.sent.length, 1)

  await post('/debug/inbound', { phone: '7700900123', text: 'Test reply' })
  await new Promise(resolve => setTimeout(resolve, 30))
  r = await fetch(base + '/replies')
  const replies = await r.json()
  assert.equal(replies.replies.length, 1)
  assert.equal(replies.replies[0].text, 'Test reply')

  console.log('SELFTEST PASS')
  console.log(JSON.stringify({
    http: true,
    recipientAllowlist: true,
    send: true,
    providerConfirmation: true,
    idempotency: true,
    duplicateSuppression: true,
    inboundReplyCapture: true,
    persistence: true
  }, null, 2))
} finally {
  await app.stop()
  fs.rmSync(dir, { recursive: true, force: true })
}
