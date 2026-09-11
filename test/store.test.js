import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { JsonStore } from '../src/store.js'

async function tempStore() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wa-store-'))
  const file = path.join(dir, 'state.json')
  const store = new JsonStore(file)
  await store.load()
  return { dir, file, store }
}


test('schema v4 legacy prospects migrate to recipients', async t => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chatrail-store-migrate-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'state.json')
  await fs.promises.writeFile(file, JSON.stringify({
    schemaVersion: 4,
    prospects: {
      '447700900123': {
        phone: '447700900123',
        name: 'Legacy Recipient',
        registeredAt: new Date().toISOString(),
        boundJids: []
      }
    },
    contacts: {},
    messages: [],
    sends: [],
    events: [],
    unresolvedMessages: []
  }), 'utf8')

  const store = new JsonStore(file)
  await store.load()
  assert.equal(store.getRecipient('447700900123').name, 'Legacy Recipient')
  assert.equal(store.snapshot().schemaVersion, 5)
  assert.equal(Object.hasOwn(store.snapshot(), 'prospects'), false)
})


test('store persists recipients and reloads them', async t => {
  const { dir, file, store } = await tempStore()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  await store.registerRecipient({ phone: '447700900123', name: 'Test' })
  const reloaded = new JsonStore(file)
  await reloaded.load()
  assert.equal(reloaded.getRecipient('447700900123').name, 'Test')
})

test('message upsert by providerId prevents duplicate event/service records', async t => {
  const { dir, store } = await tempStore()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  await store.addMessage({ id: 'one', providerId: 'p1', phone: '1', text: 'hello', direction: 'out' })
  await store.addMessage({ id: 'two', providerId: 'p1', phone: '1', text: 'hello', direction: 'out', status: 'delivered' })
  const rows = store.listMessages({ limit: 10 })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'delivered')
})

test('replies are restricted to registered recipients with an active outbound reply watch', async t => {
  const { dir, store } = await tempStore()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const now = new Date().toISOString()
  await store.registerRecipient({ phone: '5562111111111', name: 'Known', registeredAt: now })
  await store.activateReplyWatch('5562111111111', { startedAt: now, sendId: 's1', jid: '5562111111111@c.us' })
  await store.addMessage({ id: 'a', providerId: 'a', phone: '5562111111111', jid: '5562111111111@c.us', direction: 'in', text: 'yes', timestamp: now, unread: true, replyEligible: true })
  await store.addMessage({ id: 'b', providerId: 'b', phone: '5562222222222', jid: '5562222222222@c.us', direction: 'in', text: 'private', timestamp: now, unread: true, replyEligible: true })
  const replies = store.listReplies({ unreadOnly: true })
  assert.deepEqual(replies.map(r => r.text), ['yes'])
})

test('markRead only clears eligible inbound replies for target phone', async t => {
  const { dir, store } = await tempStore()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const now = new Date().toISOString()
  await store.registerRecipient({ phone: '5562111111111', name: 'Known', registeredAt: now })
  await store.activateReplyWatch('5562111111111', { startedAt: now, sendId: 's1', jid: '5562111111111@c.us' })
  await store.addMessage({ id: 'a', providerId: 'a', phone: '5562111111111', jid: '5562111111111@c.us', direction: 'in', text: 'x', timestamp: now, unread: true, replyEligible: true })
  await store.addMessage({ id: 'b', providerId: 'b', phone: '5562222222222', jid: '5562222222222@c.us', direction: 'in', text: 'y', timestamp: now, unread: true, replyEligible: true })
  assert.equal(await store.markRead('5562111111111'), 1)
  assert.equal(store.listMessages({ phone: '5562111111111' })[0].unread, false)
  assert.equal(store.listMessages({ phone: '5562222222222' })[0].unread, true)
})


test('messages before reply watch are never surfaced as replies even if unread', async t => {
  const { dir, store } = await tempStore()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const registeredAt = new Date(Date.now() - 10_000).toISOString()
  const watchAt = new Date().toISOString()
  await store.registerRecipient({ phone: '447700900123', name: 'P', registeredAt })
  await store.addMessage({ id: 'old', providerId: 'old', phone: '447700900123', jid: '111@lid', direction: 'in', text: 'old', timestamp: new Date(Date.now() - 5000).toISOString(), unread: true })
  await store.activateReplyWatch('447700900123', { startedAt: watchAt, sendId: 's1', jid: '111@lid' })
  assert.equal(store.listReplies({ unreadOnly: true }).length, 0)
})

test('bound LID prevents cross-chat contamination for same mapped phone', async t => {
  const { dir, store } = await tempStore()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const now = new Date().toISOString()
  await store.registerRecipient({ phone: '447700900123', name: 'P', registeredAt: now })
  await store.activateReplyWatch('447700900123', { startedAt: now, sendId: 's1', jid: '111@lid' })
  await store.addMessage({ id: 'good', providerId: 'good', phone: '447700900123', jid: '111@lid', direction: 'in', text: 'good', timestamp: now, unread: true, replyEligible: true })
  await store.addMessage({ id: 'wrong', providerId: 'wrong', phone: '447700900123', jid: '222@lid', direction: 'in', text: 'wrong chat', timestamp: now, unread: true, replyEligible: false })
  assert.deepEqual(store.listReplies({ unreadOnly: true }).map(m => m.text), ['good'])
})

test('schema v2 migration drops status broadcast unresolved noise', async t => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wa-store-migrate-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'state.json')
  await fs.promises.writeFile(file, JSON.stringify({
    schemaVersion: 2,
    recipients: {}, messages: [], sends: [], events: [],
    unresolvedMessages: [
      { providerId: 'status', jid: 'status@broadcast', direction: 'in' },
      { providerId: 'lid', jid: '123@lid', direction: 'in' }
    ]
  }), 'utf8')
  const store = new JsonStore(file)
  await store.load()
  assert.equal(store.snapshot().schemaVersion, 5)
  assert.deepEqual(store.listUnresolvedMessages().map(m => m.providerId), ['lid'])
})

test('store persists contact metadata and enriches messages and chats', async t => {
  const { dir, store } = await tempStore()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  await store.upsertContact({
    phone: '447700900123',
    displayName: 'Contato Real',
    name: 'Contato Real',
    pushname: 'Push',
    isMyContact: true
  })

  await store.addMessage({
    id: 'msg-contact',
    providerId: 'provider-contact',
    phone: '447700900123',
    jid: '123@lid',
    direction: 'in',
    text: 'ola',
    timestamp: new Date().toISOString(),
    unread: false,
    replyEligible: false
  })

  const [message] = store.listMessages({ phone: '447700900123' })
  assert.equal(message.contactName, 'Contato Real')
  assert.equal(message.contact.displayName, 'Contato Real')

  const [chat] = store.listChats()
  assert.equal(chat.contactName, 'Contato Real')
  assert.equal(chat.contact.displayName, 'Contato Real')
})
