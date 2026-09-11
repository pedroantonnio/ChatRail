import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createApp } from '../src/app.js'
import { FakeProvider } from '../src/providers/fake.js'
import { createLogger } from '../src/logger.js'

async function fixture({ token = '' } = {}) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wa-http-'))
  const config = {
    host: '127.0.0.1',
    port: 0,
    provider: 'fake',
    dataDir: dir,
    defaultCountryCode: '44',
    allowUnregistered: false,
    allowGroups: false,

    dedupeWindowHours: 720,
    apiToken: token,
    headless: true,
    logLevel: 'silent'
  }
  const provider = new FakeProvider({ logger: createLogger('silent') })
  const app = await createApp(config, { provider, logger: createLogger('silent') })
  const addr = await app.start({ waitForProvider: true })
  const base = `http://127.0.0.1:${addr.port}`
  return { dir, app, provider, base, token }
}

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, options)
  const body = await response.json()
  return { response, body }
}

test('HTTP end-to-end: register, send, receive reply, mark read', async t => {
  const f = await fixture()
  t.after(async () => { await f.app.stop(); fs.rmSync(f.dir, { recursive: true, force: true }) })

  let r = await jsonFetch(`${f.base}/recipients`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: '7700900123', name: 'Test Recipient' })
  })
  assert.equal(r.response.status, 201)

  r = await jsonFetch(`${f.base}/send`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: '7700900123', text: 'Hello from test', idempotencyKey: 'e2e-1' })
  })
  assert.equal(r.response.status, 201)
  assert.equal(r.body.send.providerConfirmed, true)

  r = await jsonFetch(`${f.base}/debug/inbound`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: '7700900123', text: 'Test inbound reply' })
  })
  assert.equal(r.response.status, 201)
  await new Promise(resolve => setTimeout(resolve, 30))

  r = await jsonFetch(`${f.base}/replies`)
  assert.equal(r.body.replies.length, 1)
  assert.equal(r.body.replies[0].text, 'Test inbound reply')

  r = await jsonFetch(`${f.base}/mark-read`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: '7700900123' })
  })
  assert.equal(r.body.localCount, 1)

  r = await jsonFetch(`${f.base}/replies`)
  assert.equal(r.body.replies.length, 0)
})

test('health works without token, protected routes require token', async t => {
  const f = await fixture({ token: 'secret-test-token' })
  t.after(async () => { await f.app.stop(); fs.rmSync(f.dir, { recursive: true, force: true }) })

  let r = await jsonFetch(`${f.base}/health`)
  assert.equal(r.response.status, 200)

  r = await jsonFetch(`${f.base}/status`)
  assert.equal(r.response.status, 401)

  r = await jsonFetch(`${f.base}/status`, { headers: { authorization: 'Bearer secret-test-token' } })
  assert.equal(r.response.status, 200)
})

test('malformed JSON returns deterministic 400', async t => {
  const f = await fixture()
  t.after(async () => { await f.app.stop(); fs.rmSync(f.dir, { recursive: true, force: true }) })
  const response = await fetch(`${f.base}/recipients`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad'
  })
  const body = await response.json()
  assert.equal(response.status, 400)
  assert.equal(body.error.code, 'MALFORMED_JSON')
})

test('unknown endpoint returns 404 JSON', async t => {
  const f = await fixture()
  t.after(async () => { await f.app.stop(); fs.rmSync(f.dir, { recursive: true, force: true }) })
  const r = await jsonFetch(`${f.base}/does-not-exist`)
  assert.equal(r.response.status, 404)
  assert.equal(r.body.error.code, 'NOT_FOUND')
})


test('HTTP unresolved endpoint exposes provider messages whose LID could not be mapped', async t => {
  const f = await fixture()
  t.after(async () => { await f.app.stop(); fs.rmSync(f.dir, { recursive: true, force: true }) })
  f.provider.emit('unresolved_message', {
    providerId: 'unresolved-http-1',
    jid: '123456789012345@lid',
    direction: 'in',
    text: 'unmapped reply',
    timestamp: new Date().toISOString(),
    reason: 'lid_unresolved'
  })
  await new Promise(resolve => setTimeout(resolve, 30))
  const r = await jsonFetch(`${f.base}/unresolved`)
  assert.equal(r.response.status, 200)
  assert.equal(r.body.messages.length, 1)
  assert.equal(r.body.messages[0].jid, '123456789012345@lid')
})

test('HTTP reply-state exposes reply epoch and excludes pre-outreach history', async t => {
  const f = await fixture()
  t.after(async () => { await f.app.stop(); fs.rmSync(f.dir, { recursive: true, force: true }) })

  let r = await jsonFetch(`${f.base}/recipients`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: '7700900123', name: 'Test Recipient' })
  })
  assert.equal(r.response.status, 201)

  await f.provider.simulateInbound('447700900123', 'old chat history')
  await new Promise(resolve => setTimeout(resolve, 20))

  r = await jsonFetch(`${f.base}/replies`)
  assert.equal(r.body.replies.length, 0)

  r = await jsonFetch(`${f.base}/send`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: '7700900123', text: 'outreach', idempotencyKey: 'reply-epoch-1' })
  })
  assert.equal(r.response.status, 201)

  r = await jsonFetch(`${f.base}/reply-state?phone=7700900123`)
  assert.equal(r.response.status, 200)
  assert.ok(r.body.watch.watchAt)
  assert.equal(r.body.realSendCount, 1)
  assert.equal(r.body.eligibleReplyCount, 0)

  await f.provider.simulateInbound('447700900123', 'new reply')
  await new Promise(resolve => setTimeout(resolve, 20))
  r = await jsonFetch(`${f.base}/replies`)
  assert.deepEqual(r.body.replies.map(m => m.text), ['new reply'])
})

test('HTTP /sends exposes persisted send attempts', async t => {
  const f = await fixture()
  t.after(async () => { await f.app.stop(); fs.rmSync(f.dir, { recursive: true, force: true }) })

  await jsonFetch(`${f.base}/recipients`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      phone: '7700900123',
      name: 'Send History Test'
    })
  })

  await jsonFetch(`${f.base}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      phone: '7700900123',
      text: 'history test',
      idempotencyKey: 'history-test-1'
    })
  })

  const r = await jsonFetch(`${f.base}/sends?phone=7700900123&limit=20`)
  assert.equal(r.response.status, 200)
  assert.equal(r.body.sends.length, 1)
  assert.equal(r.body.sends[0].phone, '447700900123')
  assert.equal(r.body.sends[0].idempotencyKey, 'history-test-1')
})