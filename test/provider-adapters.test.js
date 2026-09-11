import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { WWebJSProvider, ackToStatus, providerIdFromMessage } from '../src/providers/wwebjs.js'
import { BaileysProvider, extractText, statusFromNumber } from '../src/providers/baileys.js'
import { createLogger } from '../src/logger.js'

const silent = createLogger('silent')

test('wwebjs ack mapping matches common delivery states', () => {
  assert.equal(ackToStatus(-1), 'error')
  assert.equal(ackToStatus(1), 'server')
  assert.equal(ackToStatus(2), 'delivered')
  assert.equal(ackToStatus(3), 'read')
})

test('wwebjs regression: sendMessage undefined is confirmed by message_create correlation', async () => {
  const provider = new WWebJSProvider({ logger: silent, dataDir: '.', headless: true })
  provider.setState('ready')
  provider.client = {
    isRegisteredUser: async () => true,
    sendMessage: async (jid, text) => {
      setTimeout(() => provider._onMessageCreate({
        fromMe: true,
        to: jid,
        from: 'me@c.us',
        body: text,
        timestamp: Math.floor(Date.now() / 1000),
        id: { _serialized: 'real-event-id' }
      }), 15)
      return undefined
    }
  }
  const sent = await provider.sendText('447700900123', 'hello')
  assert.equal(sent.confirmed, true)
  assert.equal(sent.providerId, 'real-event-id')
})

test('wwebjs sendMessage direct ID is immediately confirmed', async () => {
  const provider = new WWebJSProvider({ logger: silent, dataDir: '.', headless: true })
  provider.setState('ready')
  provider.client = {
    isRegisteredUser: async () => true,
    sendMessage: async () => ({ id: { _serialized: 'direct-id' } })
  }
  const sent = await provider.sendText('447700900123', 'hello')
  assert.equal(sent.confirmed, true)
  assert.equal(sent.providerId, 'direct-id')
})

test('wwebjs inbound event exposes normalized phone and ignores no text assumptions', async () => {
  const provider = new WWebJSProvider({ logger: silent, dataDir: '.', headless: true })
  const messages = []
  provider.on('message', m => messages.push(m))
  await provider._onMessageCreate({
    fromMe: false,
    from: '447700900123@c.us',
    to: 'me@c.us',
    body: 'inbound',
    timestamp: Math.floor(Date.now() / 1000),
    id: { _serialized: 'in-1' }
  })
  assert.equal(messages.length, 1)
  assert.equal(messages[0].phone, '447700900123')
  assert.equal(messages[0].direction, 'in')
})


test('wwebjs provider ID supports current $1 WhatsApp Web serialization', () => {
  assert.equal(providerIdFromMessage({ id: { $1: 'false_123@lid_ABC' } }), 'false_123@lid_ABC')
  assert.equal(providerIdFromMessage({ id: { fromMe: false, remote: '123@lid', id: 'ABC' } }), 'false_123@lid_ABC')
})

test('wwebjs resolves inbound @lid through getContactLidAndPhone and emits canonical phone', async () => {
  const provider = new WWebJSProvider({ logger: silent, dataDir: '.', headless: true, persistIdentityMap: false })
  provider.client = {
    getContactLidAndPhone: async ids => [{ lid: ids[0], pn: '447700900123@c.us' }]
  }
  const messages = []
  provider.on('message', m => messages.push(m))
  await provider._handleMessage({
    fromMe: false,
    from: '130786200146109@lid',
    to: 'me@c.us',
    body: 'reply',
    timestamp: Math.floor(Date.now() / 1000),
    id: { $1: 'false_130786200146109@lid_X1' }
  }, 'message')
  assert.equal(messages.length, 1)
  assert.equal(messages[0].phone, '447700900123')
  assert.equal(provider.lidToPhone.get('130786200146109@lid'), '447700900123')
})

test('wwebjs outgoing @lid event correlates a unique pending send by text and learns mapping', async () => {
  const provider = new WWebJSProvider({ logger: silent, dataDir: '.', headless: true, persistIdentityMap: false })
  provider.setState('ready')
  provider.client = {
    sendMessage: async (jid, text) => {
      setTimeout(() => provider._handleMessage({
        fromMe: true,
        to: '130786200146109@lid',
        from: 'me@c.us',
        body: text,
        timestamp: Math.floor(Date.now() / 1000),
        id: { $1: 'true_130786200146109@lid_OUT1' }
      }, 'message_create'), 15)
      return undefined
    },
    getContactLidAndPhone: async () => { throw new Error('upstream mapping unavailable') }
  }
  const sent = await provider.sendText('447700900123', 'unique outbound')
  assert.equal(sent.confirmed, true)
  assert.equal(sent.providerId, 'true_130786200146109@lid_OUT1')
  assert.equal(provider.lidToPhone.get('130786200146109@lid'), '447700900123')
})

test('wwebjs learned LID mapping resolves later inbound reply without another upstream lookup', async () => {
  const provider = new WWebJSProvider({ logger: silent, dataDir: '.', headless: true, persistIdentityMap: false })
  await provider._rememberIdentity('130786200146109@lid', '447700900123', 'test')
  let lookups = 0
  provider.client = { getContactLidAndPhone: async () => { lookups += 1; throw new Error('should not be called') } }
  const messages = []
  provider.on('message', m => messages.push(m))
  await provider._handleMessage({
    fromMe: false,
    from: '130786200146109@lid',
    body: 'reply after send',
    id: { $1: 'false_130786200146109@lid_IN2' }
  }, 'message')
  assert.equal(lookups, 0)
  assert.equal(messages[0].phone, '447700900123')
})

test('wwebjs deduplicates same inbound message observed by message and message_create', async () => {
  const provider = new WWebJSProvider({ logger: silent, dataDir: '.', headless: true, persistIdentityMap: false })
  const messages = []
  provider.on('message', m => messages.push(m))
  const raw = {
    fromMe: false,
    from: '447700900123@c.us',
    body: 'once',
    id: { $1: 'false_447700900123@c.us_DUPE' }
  }
  await provider._handleMessage(raw, 'message')
  await provider._handleMessage(raw, 'message_create')
  assert.equal(messages.length, 1)
})

test('wwebjs unresolved LID is surfaced instead of being misreported as a phone number', async () => {
  const provider = new WWebJSProvider({ logger: silent, dataDir: '.', headless: true, persistIdentityMap: false })
  provider.client = { getContactLidAndPhone: async () => { throw new Error('unavailable') } }
  const unresolved = []
  const messages = []
  provider.on('unresolved_message', m => unresolved.push(m))
  provider.on('message', m => messages.push(m))
  await provider._handleMessage({
    fromMe: false,
    from: '279679747514464@lid',
    body: 'unknown',
    id: { $1: 'false_279679747514464@lid_UNKNOWN' }
  }, 'message')
  assert.equal(messages.length, 0)
  assert.equal(unresolved.length, 1)
  assert.equal(unresolved[0].jid, '279679747514464@lid')
  assert.equal(unresolved[0].reason, 'lid_unresolved')
})

test('Baileys text extraction handles common message containers', () => {
  assert.equal(extractText({ conversation: 'a' }), 'a')
  assert.equal(extractText({ extendedTextMessage: { text: 'b' } }), 'b')
  assert.equal(extractText({ imageMessage: { caption: 'c' } }), 'c')
  assert.equal(extractText({ videoMessage: { caption: 'd' } }), 'd')
})

test('Baileys status mapping is stable for send/delivery/read', () => {
  assert.equal(statusFromNumber(2), 'server')
  assert.equal(statusFromNumber(3), 'delivered')
  assert.equal(statusFromNumber(4), 'read')
})

test('Baileys adapter send contract works against socket contract', async () => {
  const provider = new BaileysProvider({ logger: silent, dataDir: '.' })
  provider.setState('ready')
  let called = null
  provider.sock = {
    onWhatsApp: async phone => [{ exists: true, jid: `${phone}@s.whatsapp.net` }],
    sendMessage: async (jid, content) => {
      called = { jid, content }
      return { key: { id: 'baileys-id' } }
    }
  }
  const sent = await provider.sendText('447700900123', 'hello')
  assert.equal(sent.confirmed, true)
  assert.equal(sent.providerId, 'baileys-id')
  assert.deepEqual(called.content, { text: 'hello' })
})

test('Baileys adapter rejects unregistered number through socket contract', async () => {
  const provider = new BaileysProvider({ logger: silent, dataDir: '.' })
  provider.setState('ready')
  provider.sock = {
    onWhatsApp: async () => [{ exists: false }],
    sendMessage: async () => { throw new Error('should not be called') }
  }
  await assert.rejects(provider.sendText('447700900123', 'hello'), /not registered/)
})


test('wwebjs LID mapping persists across provider restarts', async t => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wa-lid-map-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const first = new WWebJSProvider({ logger: silent, dataDir: dir, persistIdentityMap: true })
  await first._rememberIdentity('130786200146109@lid', '447700900123', 'test')
  const second = new WWebJSProvider({ logger: silent, dataDir: dir, persistIdentityMap: true })
  await second._loadIdentityMap()
  assert.equal(second.lidToPhone.get('130786200146109@lid'), '447700900123')
  assert.equal(second.phoneToLid.get('447700900123'), '130786200146109@lid')
})


test('wwebjs attaches canonical inbound message listener, not only message_create', async () => {
  const provider = new WWebJSProvider({ logger: silent, dataDir: '.', persistIdentityMap: false })
  const client = new EventEmitter()
  provider.client = client
  const messages = []
  provider.on('message', m => messages.push(m))
  provider._attachClientEvents()
  client.emit('message', {
    fromMe: false,
    from: '447700900123@c.us',
    body: 'real inbound event',
    id: { $1: 'false_447700900123@c.us_REALIN' }
  })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(messages.length, 1)
  assert.equal(messages[0].direction, 'in')
  assert.equal(messages[0].phone, '447700900123')
})

test('wwebjs ignores status broadcast instead of polluting unresolved diagnostics', async () => {
  const provider = new WWebJSProvider({ logger: silent, dataDir: '.', persistIdentityMap: false })
  const unresolved = []
  const messages = []
  provider.on('unresolved_message', m => unresolved.push(m))
  provider.on('message', m => messages.push(m))
  await provider._handleMessage({
    fromMe: false,
    from: 'status@broadcast',
    body: 'status text',
    id: { $1: 'false_status@broadcast_ABC' },
    timestamp: Math.floor(Date.now() / 1000)
  }, 'message')
  assert.equal(messages.length, 0)
  assert.equal(unresolved.length, 0)
})

test('wwebjs marks startup replay older than ready epoch as historical and not unread', async () => {
  const provider = new WWebJSProvider({ logger: silent, dataDir: '.', persistIdentityMap: false })
  provider.readyAtMs = Date.now()
  const messages = []
  provider.on('message', m => messages.push(m))
  await provider._handleMessage({
    fromMe: false,
    from: '447700900123@c.us',
    body: 'old synced message',
    id: { $1: 'false_447700900123@c.us_OLD' },
    timestamp: Math.floor((Date.now() - 10 * 60_000) / 1000)
  }, 'message')
  assert.equal(messages.length, 1)
  assert.equal(messages[0].historical, true)
  assert.equal(messages[0].unread, false)
})

test('wwebjs refuses conflicting LID mapping instead of silently reassigning another chat', async () => {
  const provider = new WWebJSProvider({ logger: silent, dataDir: '.', persistIdentityMap: false })
  const conflicts = []
  provider.on('identity_conflict', c => conflicts.push(c))
  assert.equal(await provider._rememberIdentity('111@lid', '447700900123', 'first'), true)
  assert.equal(await provider._rememberIdentity('111@lid', '5562888888888', 'second'), false)
  assert.equal(provider.lidToPhone.get('111@lid'), '447700900123')
  assert.equal(conflicts.length, 1)
})

test('wwebjs resolveRecipient learns authoritative LID returned by getNumberId', async () => {
  const provider = new WWebJSProvider({ logger: silent, dataDir: '.', persistIdentityMap: false })
  provider.client = {
    getNumberId: async () => ({ _serialized: '777@lid' }),
    isRegisteredUser: async () => { throw new Error('fallback should not run') }
  }
  const result = await provider.resolveRecipient('447700900123')
  assert.equal(result.registered, true)
  assert.equal(result.jid, '777@lid')
  assert.equal(provider.lidToPhone.get('777@lid'), '447700900123')
})

test('wwebjs sendText prefers learned LID over reconstructed c.us', async () => {
  const provider = new WWebJSProvider({ logger: silent, dataDir: '.', headless: true, persistIdentityMap: false })
  provider.setState('ready')
  await provider._rememberIdentity('777@lid', '447700900123', 'test')

  let calledJid = null
  provider.client = {
    sendMessage: async (jid) => {
      calledJid = jid
      return {
        id: { _serialized: 'direct-lid-id' },
        to: jid
      }
    }
  }

  const sent = await provider.sendText('447700900123', 'hello via lid')
  assert.equal(calledJid, '777@lid')
  assert.equal(sent.confirmed, true)
  assert.equal(sent.jid, '777@lid')
})

test('wwebjs sendText falls back to c.us when no LID mapping is known', async () => {
  const provider = new WWebJSProvider({ logger: silent, dataDir: '.', headless: true, persistIdentityMap: false })
  provider.setState('ready')

  let calledJid = null
  provider.client = {
    sendMessage: async (jid) => {
      calledJid = jid
      return {
        id: { _serialized: 'direct-cus-id' },
        to: jid
      }
    }
  }

  const sent = await provider.sendText('447700900123', 'hello via c.us')
  assert.equal(calledJid, '447700900123@c.us')
  assert.equal(sent.confirmed, true)
})
test('wwebjs reconciles authenticated to ready when live runtime is synced', async () => {
  const provider = new WWebJSProvider({ logger: silent, dataDir: '.', persistIdentityMap: false })
  provider.setState('authenticated')
  provider.client = {
    getState: async () => 'CONNECTED',
    pupPage: {
      evaluate: async () => ({ hasWWebJS: true, hasSynced: true })
    }
  }

  const recovered = await provider._reconcileReadyState({ attempts: 1, intervalMs: 0 })
  assert.equal(recovered, true)
  assert.equal(provider.state, 'ready')
  assert.ok(provider.readyAtMs > 0)
})

test('wwebjs does not reconcile ready before WhatsApp sync completes', async () => {
  const provider = new WWebJSProvider({ logger: silent, dataDir: '.', persistIdentityMap: false })
  provider.setState('authenticated')
  provider.client = {
    getState: async () => 'CONNECTED',
    pupPage: {
      evaluate: async () => ({ hasWWebJS: true, hasSynced: false })
    }
  }

  const recovered = await provider._reconcileReadyState({ attempts: 1, intervalMs: 0 })
  assert.equal(recovered, false)
  assert.equal(provider.state, 'authenticated')
})

test('wwebjs duplicate authenticated event cannot downgrade ready state', async () => {
  const provider = new WWebJSProvider({ logger: silent, dataDir: '.', persistIdentityMap: false })
  const client = new EventEmitter()
  client.getState = async () => 'CONNECTED'
  client.pupPage = {
    evaluate: async () => ({ hasWWebJS: true, hasSynced: true })
  }
  provider.client = client
  provider._attachClientEvents()

  provider.setState('ready')
  client.emit('authenticated')
  await new Promise(resolve => setTimeout(resolve, 10))

  assert.equal(provider.state, 'ready')
})
test('wwebjs message includes resolved contact display name', async () => {
  const provider = new WWebJSProvider({ persistIdentityMap: false })
  provider.client = {
    getContactById: async id => ({
      id: { _serialized: id },
      name: 'Nome Salvo',
      pushname: 'Push Name',
      shortName: 'Nome',
      verifiedName: 'Empresa Verificada',
      isMyContact: true,
      isMe: false
    })
  }

  const seen = new Promise(resolve => provider.once('message', resolve))
  await provider._onMessageCreate({
    fromMe: false,
    from: '447700900123@c.us',
    body: 'oi',
    timestamp: Math.floor(Date.now() / 1000),
    id: { _serialized: 'contact-name-test' }
  })

  const message = await seen
  assert.equal(message.contact.displayName, 'Nome Salvo')
  assert.equal(message.contact.name, 'Nome Salvo')
  assert.equal(message.contact.pushname, 'Push Name')
  assert.equal(message.contact.isMyContact, true)
})

test('wwebjs contact display name falls back to pushname then verified name', async () => {
  const provider = new WWebJSProvider({ persistIdentityMap: false })
  provider.client = {}

  const push = provider._contactInfoFromContact(
    { pushname: 'Julia', verifiedName: 'Empresa' },
    '5561000000000',
    '1@lid',
    'test'
  )
  assert.equal(push.displayName, 'Julia')

  const verified = provider._contactInfoFromContact(
    { verifiedName: 'Empresa' },
    '5562000000000',
    '2@lid',
    'test'
  )
  assert.equal(verified.displayName, 'Empresa')
})


test('wwebjs nameless contact falls back to chat formatted title without inventing a name', async () => {
  const provider = new WWebJSProvider({ persistIdentityMap: false })
  provider.client = {
    getContactById: async () => ({
      id: { _serialized: '556284710833@c.us' },
      name: null,
      pushname: null,
      shortName: null,
      verifiedName: null,
      isMyContact: false,
      isMe: false
    }),
    getChatById: async () => ({
      name: null,
      formattedTitle: '+55 62 8471-0833',
      contact: {
        isMyContact: false,
        isMe: false
      }
    })
  }

  const info = await provider.resolveContactInfo(
    '556284710833',
    '129476235133063@lid'
  )

  assert.equal(info.displayName, '+55 62 8471-0833')
  assert.equal(info.name, null)
  assert.match(info.source, /^getChatById:/)
})


test('wwebjs lists real unread chats without marking them read', async () => {
  const provider = new WWebJSProvider({ persistIdentityMap: false })

  let sendSeenCalls = 0
  provider.client = {
    getChats: async () => [
      {
        id: { _serialized: '120363000000000000@g.us' },
        name: 'Unread group',
        isGroup: true,
        unreadCount: 2,
        timestamp: 100,
        sendSeen: async () => { sendSeenCalls += 1 },
        fetchMessages: async () => [
          {
            id: { _serialized: 'm1' },
            from: '120363000000000000@g.us',
            author: '5511999999999@c.us',
            body: 'one',
            type: 'chat',
            timestamp: 90,
            fromMe: false
          },
          {
            id: { _serialized: 'm2' },
            from: '120363000000000000@g.us',
            author: '5511888888888@c.us',
            body: 'two',
            type: 'chat',
            timestamp: 100,
            fromMe: false
          }
        ]
      },
      {
        id: { _serialized: '5511777777777@c.us' },
        name: 'Read chat',
        isGroup: false,
        unreadCount: 0,
        timestamp: 80,
        fetchMessages: async () => {
          throw new Error('must not fetch read chat')
        }
      }
    ]
  }

  const rows = await provider.listUnreadChats()

  assert.equal(rows.length, 1)
  assert.equal(rows[0].jid, '120363000000000000@g.us')
  assert.equal(rows[0].isGroup, true)
  assert.equal(rows[0].unreadCount, 2)
  assert.deepEqual(rows[0].messages.map(message => message.body), ['one', 'two'])
  assert.equal(sendSeenCalls, 0)
})
