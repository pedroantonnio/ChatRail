import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { JsonStore } from '../src/store.js'
import { WhatsAppService } from '../src/service.js'
import { FakeProvider } from '../src/providers/fake.js'
import { createLogger } from '../src/logger.js'

async function fixture(overrides = {}) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wa-service-'))
  const store = new JsonStore(path.join(dir, 'state.json'))
  await store.load()
  const provider = new FakeProvider({ logger: createLogger('silent') })
  await provider.start()
  const config = {
    defaultCountryCode: '44',
    allowUnregistered: false,
    allowGroups: false,

    dedupeWindowHours: 720,
    ...overrides
  }
  const service = new WhatsAppService({ config, store, provider, logger: createLogger('silent') })
  return { dir, store, provider, service }
}


test('cannot send to unregistered recipient by default', async t => {
  const f = await fixture()
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }))
  await assert.rejects(
    f.service.send({ phone: '7700900123', text: 'Oi' }),
    error => error.code === 'UNREGISTERED_RECIPIENT'
  )
})

test('registered recipient send records provider-confirmed outgoing message', async t => {
  const f = await fixture()
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }))
  await f.service.registerRecipient({ phone: '7700900123', name: 'Recipient' })
  const result = await f.service.send({ phone: '7700900123', text: 'example message' })
  assert.equal(result.send.status, 'sent')
  assert.equal(result.send.providerConfirmed, true)
  assert.equal(f.provider.sent.length, 1)
  const messages = f.store.listMessages({ phone: '447700900123' })
  assert.equal(messages.length, 1)
  assert.equal(messages[0].direction, 'out')
})

test('exact duplicate is suppressed without calling provider twice', async t => {
  const f = await fixture()
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }))
  await f.service.registerRecipient({ phone: '7700900123', name: 'Recipient' })
  const first = await f.service.send({ phone: '7700900123', text: 'Mesmo texto' })
  const second = await f.service.send({ phone: '7700900123', text: 'Mesmo texto' })
  assert.equal(first.duplicate, false)
  assert.equal(second.duplicate, true)
  assert.equal(f.provider.sent.length, 1)
})

test('concurrent identical sends are serialized and deduplicated', async t => {
  const f = await fixture()
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }))
  f.provider.sendDelayMs = 60
  await f.service.registerRecipient({ phone: '7700900123', name: 'Recipient' })
  const results = await Promise.all(Array.from({ length: 8 }, () =>
    f.service.send({ phone: '7700900123', text: 'Concorrente' })
  ))
  assert.equal(f.provider.sent.length, 1)
  assert.equal(results.filter(r => r.duplicate === false).length, 1)
  assert.equal(results.filter(r => r.duplicate === true).length, 7)
})

test('idempotency key rejects reuse with different payload', async t => {
  const f = await fixture()
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }))
  await f.service.registerRecipient({ phone: '7700900123', name: 'Recipient' })
  await f.service.send({ phone: '7700900123', text: 'A', idempotencyKey: 'abc' })
  await assert.rejects(
    f.service.send({ phone: '7700900123', text: 'B', idempotencyKey: 'abc' }),
    error => error.code === 'IDEMPOTENCY_CONFLICT'
  )
})

test('dry run never calls provider and does not block later real send', async t => {
  const f = await fixture()
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }))
  await f.service.registerRecipient({ phone: '7700900123', name: 'Recipient' })
  const dry = await f.service.send({ phone: '7700900123', text: 'Preview', dryRun: true })
  const real = await f.service.send({ phone: '7700900123', text: 'Preview' })
  assert.equal(dry.dryRun, true)
  assert.equal(real.duplicate, false)
  assert.equal(f.provider.sent.length, 1)
})

test('provider send failure is persisted and surfaced', async t => {
  const f = await fixture()
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }))
  await f.service.registerRecipient({ phone: '7700900123', name: 'Recipient' })
  f.provider.failSend = true
  await assert.rejects(
    f.service.send({ phone: '7700900123', text: 'Falhar' }),
    error => error.code === 'PROVIDER_SEND_FAILED'
  )
  const snapshot = f.store.snapshot()
  assert.equal(snapshot.sends.at(-1).status, 'failed')
})

test('inbound provider event becomes recipient reply only after outbound watch starts and mark-read clears it', async t => {
  const f = await fixture()
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }))
  await f.service.registerRecipient({ phone: '7700900123', name: 'Recipient' })
  await f.provider.simulateInbound('447700900123', 'historical before outreach')
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(f.store.listReplies({ unreadOnly: true }).length, 0)

  await f.service.send({ phone: '7700900123', text: 'Oferta' })
  await f.provider.simulateInbound('447700900123', 'Test reply')
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(f.store.listReplies({ unreadOnly: true }).length, 1)
  assert.equal(f.store.listReplies({ unreadOnly: true })[0].text, 'Test reply')
  const marked = await f.service.markRead('7700900123')
  assert.equal(marked.localCount, 1)
  assert.equal(f.store.listReplies({ unreadOnly: true }).length, 0)
})

test('provider not ready returns 503 before attempting send', async t => {
  const f = await fixture()
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }))
  await f.service.registerRecipient({ phone: '7700900123', name: 'Recipient' })
  f.provider.setState('disconnected')
  await assert.rejects(
    f.service.send({ phone: '7700900123', text: 'Oi' }),
    error => error.code === 'PROVIDER_NOT_READY' && error.status === 503
  )
  assert.equal(f.provider.sent.length, 0)
})

test('provider recipient check blocks non-WhatsApp number', async t => {
  const f = await fixture()
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }))
  f.provider.registered.add('5511999999999')
  await f.service.registerRecipient({ phone: '7700900123', name: 'Recipient' })
  await assert.rejects(
    f.service.send({ phone: '7700900123', text: 'Oi' }),
    error => error.code === 'WHATSAPP_NOT_REGISTERED'
  )
  assert.equal(f.provider.sent.length, 0)
})

test('force bypasses duplicate text suppression but not allowlist', async t => {
  const f = await fixture()
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }))
  await f.service.registerRecipient({ phone: '7700900123', name: 'Recipient' })
  await f.service.send({ phone: '7700900123', text: 'Retry intentional' })
  const second = await f.service.send({ phone: '7700900123', text: 'Retry intentional', force: true })
  assert.equal(second.duplicate, false)
  assert.equal(f.provider.sent.length, 2)
  await assert.rejects(
    f.service.send({ phone: '62988888888', text: 'No allowlist', force: true }),
    error => error.code === 'UNREGISTERED_RECIPIENT'
  )
})

test('ack event upgrades persisted outgoing status', async t => {
  const f = await fixture()
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }))
  await f.service.registerRecipient({ phone: '7700900123', name: 'Recipient' })
  const result = await f.service.send({ phone: '7700900123', text: 'Ack me' })
  f.provider.simulateAck(result.send.providerId, 'read')
  await new Promise(resolve => setTimeout(resolve, 30))
  const row = f.store.listMessages({ phone: '447700900123' })[0]
  assert.equal(row.status, 'read')
})

test('rejects corrupted recipient metadata containing Unicode replacement characters', async t => {
  const f = await fixture()
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }))
  await assert.rejects(
    f.service.registerRecipient({ phone: '7700900123', name: 'broken�name' }),
    error => error.code === 'TEXT_ENCODING_INVALID' && error.status === 400
  )
})


test('unresolved provider identity is persisted for diagnostics instead of silently disappearing', async t => {
  const f = await fixture()
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }))
  f.provider.emit('unresolved_message', {
    providerId: 'u-1',
    jid: '123456789012345@lid',
    direction: 'in',
    text: 'reply',
    timestamp: new Date().toISOString(),
    reason: 'lid_unresolved'
  })
  await new Promise(resolve => setTimeout(resolve, 30))
  const unresolved = f.store.listUnresolvedMessages({ limit: 10 })
  assert.equal(unresolved.length, 1)
  assert.equal(unresolved[0].jid, '123456789012345@lid')
  assert.equal(f.service.status().counts.unresolvedMessages, 1)
})


test('historical inbound replay after provider startup is persisted but never becomes unread reply', async t => {
  const f = await fixture()
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }))
  await f.service.registerRecipient({ phone: '7700900123', name: 'Recipient' })
  await f.service.send({ phone: '7700900123', text: 'Oferta' })
  f.provider.emit('message', {
    providerId: 'historic-1',
    phone: '447700900123',
    jid: '447700900123@c.us',
    direction: 'in',
    text: 'mensagem antiga',
    timestamp: new Date(Date.now() - 3600_000).toISOString(),
    historical: true,
    status: 'received',
    unread: true
  })
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(f.store.listReplies({ unreadOnly: true }).length, 0)
  const row = f.store.listMessages({ phone: '447700900123' }).find(m => m.providerId === 'historic-1')
  assert.equal(row.unread, false)
  assert.equal(row.replyEligible, false)
})

test('recipient re-registration does not reset reply watch or registeredAt', async t => {
  const f = await fixture()
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }))
  const first = await f.service.registerRecipient({ phone: '7700900123', name: 'Recipient' })
  await f.service.send({ phone: '7700900123', text: 'Oferta' })
  const watched = f.store.getRecipient('447700900123')
  await new Promise(resolve => setTimeout(resolve, 5))
  const second = await f.service.registerRecipient({ phone: '7700900123', name: 'Updated Recipient' })
  assert.equal(second.registeredAt, first.registeredAt)
  assert.equal(second.replyWatchStartedAt, watched.replyWatchStartedAt)
})
