import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { BaseProvider } from './base.js'
import { phoneFromJid, isGroupJid, jidKind } from '../normalize.js'

const require = createRequire(import.meta.url)

export function ackToStatus(ack) {
  const map = {
    '-1': 'error',
    '0': 'pending',
    '1': 'server',
    '2': 'delivered',
    '3': 'read',
    '4': 'played'
  }
  return map[String(ack)] || `ack_${ack}`
}

export function providerIdFromMessage(message) {
  const id = message?.id
  if (!id) return null
  if (id._serialized) return String(id._serialized)
  if (id.$1) return String(id.$1)
  if (id.id) {
    const remote = id.remote?._serialized || id.remote?.$1 || id.remote || message?.to || message?.from || ''
    return `${Boolean(id.fromMe)}_${String(remote)}_${String(id.id)}`
  }
  return null
}

function canonicalPhone(value) {
  const direct = phoneFromJid(value)
  if (direct) return direct
  const digits = String(value || '').replace(/\D/g, '')
  return digits.length >= 10 && digits.length <= 15 ? digits : null
}

function remoteJidFromMessage(message) {
  const remote = message?.id?.remote?._serialized || message?.id?.remote?.$1 || message?.id?.remote || null
  if (remote) return String(remote)
  const fallback = message?.fromMe ? message?.to : message?.from
  return fallback ? String(fallback) : null
}

function isIgnoredJid(jid) {
  const raw = String(jid || '').toLowerCase()
  return raw === 'status@broadcast' || raw.endsWith('@broadcast') || raw.endsWith('@newsletter')
}

export class WWebJSProvider extends BaseProvider {
  constructor({ logger, dataDir, headless = true, allowGroups = false, persistIdentityMap = true } = {}) {
    super({ logger, allowGroups })
    this.providerName = 'wwebjs'
    this.dataDir = dataDir
    this.headless = headless
    this.client = null
    this.pending = []
    this.lastInboundByPhone = new Map()
    this.lidToPhone = new Map()
    this.phoneToLid = new Map()
    this.seenProviderIds = new Set()
    this.persistIdentityMap = persistIdentityMap
    this.identityMapPath = path.join(this.dataDir || '.', 'wwebjs-id-map.json')
    this._identityWriteChain = Promise.resolve()
    this.readyAtMs = 0
    this._stopping = false
    this._readyReconcilePromise = null
    this._readyReconcileEpoch = 0
  }

  async _loadIdentityMap() {
    if (!this.persistIdentityMap) return
    try {
      if (!fs.existsSync(this.identityMapPath)) return
      const parsed = JSON.parse(await fs.promises.readFile(this.identityMapPath, 'utf8'))
      for (const [lid, phone] of Object.entries(parsed?.lidToPhone || {})) {
        if (jidKind(lid) !== 'lid') continue
        const canonical = canonicalPhone(phone)
        if (!canonical) continue
        this.lidToPhone.set(lid, canonical)
        this.phoneToLid.set(canonical, lid)
      }
    } catch (error) {
      this.logger?.warn?.(`Could not load LID map; continuing with an empty map: ${error.message}`)
    }
  }

  async _persistIdentityMap() {
    if (!this.persistIdentityMap) return
    const dir = path.dirname(this.identityMapPath)
    const payload = JSON.stringify({
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      lidToPhone: Object.fromEntries(this.lidToPhone)
    }, null, 2)
    const tmp = `${this.identityMapPath}.${process.pid}.${crypto.randomUUID()}.tmp`
    this._identityWriteChain = this._identityWriteChain.then(async () => {
      await fs.promises.mkdir(dir, { recursive: true })
      await fs.promises.writeFile(tmp, payload, 'utf8')
      await fs.promises.rename(tmp, this.identityMapPath)
    })
    return this._identityWriteChain
  }

  async _rememberIdentity(lid, phone, source = 'unknown') {
    if (jidKind(lid) !== 'lid') return false
    const canonical = canonicalPhone(phone)
    if (!canonical) return false

    const existingPhone = this.lidToPhone.get(lid) || null
    const existingLid = this.phoneToLid.get(canonical) || null

    if (existingPhone && existingPhone !== canonical) {
      const conflict = {
        lid,
        phone: canonical,
        existingPhone,
        source,
        timestamp: new Date().toISOString()
      }
      this.logger?.warn?.(`Refusing conflicting LID mapping ${lid}: ${existingPhone} != ${canonical} (${source})`)
      this.emit('identity_conflict', conflict)
      return false
    }

    if (existingLid && existingLid !== lid) {
      const conflict = {
        lid,
        phone: canonical,
        existingLid,
        source,
        timestamp: new Date().toISOString()
      }
      this.logger?.warn?.(`Refusing conflicting phone mapping ${canonical}: ${existingLid} != ${lid} (${source})`)
      this.emit('identity_conflict', conflict)
      return false
    }

    const changed = existingPhone !== canonical
    this.lidToPhone.set(lid, canonical)
    this.phoneToLid.set(canonical, lid)
    if (changed) {
      await this._persistIdentityMap()
      this.emit('identity', { lid, phone: canonical, source, timestamp: new Date().toISOString() })
    }
    return true
  }

  async start() {
    this._stopping = false
    this._readyReconcileEpoch += 1
    await this._loadIdentityMap()

    let pkg
    try {
      pkg = require('whatsapp-web.js')
    } catch (error) {
      throw new Error(`whatsapp-web.js is not installed. Run npm install. ${error.message}`)
    }

    const qrcode = require('qrcode-terminal')
    const { Client, LocalAuth } = pkg
    const authPath = path.join(this.dataDir, 'wwebjs-auth')

    this.client = new Client({
      authStrategy: new LocalAuth({ clientId: 'chatrail', dataPath: authPath }),
      puppeteer: {
        headless: this.headless,
        args: ['--disable-dev-shm-usage']
      }
    })

    this.setState('connecting')
    this._attachClientEvents(qrcode)

    await this.client.initialize()
  }

  _attachClientEvents(qrcode = { generate() {} }) {
    this.client.on('qr', qr => {
      this.setState('qr', { qrAvailable: true })
      this.logger?.info('Scan the QR code below in WhatsApp > Linked devices')
      qrcode.generate(qr, { small: true })
    })

    this.client.on('authenticated', () => {
      // whatsapp-web.js can emit authenticated more than once. Never let a
      // duplicate event downgrade an already-operational provider.
      if (this.state !== 'ready') this.setState('authenticated')
      this._scheduleReadyReconciliation()
    })
    this.client.on('ready', () => {
      this.readyAtMs = Date.now()
      if (this.state !== 'ready') this.setState('ready')
    })
    this.client.on('auth_failure', message => {
      this._readyReconcileEpoch += 1
      this.setState('auth_failure', { message })
    })
    this.client.on('disconnected', reason => {
      this._readyReconcileEpoch += 1
      this.setState('disconnected', { reason: String(reason) })
    })

    // `message` is the canonical inbound event. `message_create` is retained as
    // a fallback and for observing/correlating our own outgoing messages.
    this.client.on('message', message => this._handleMessage(message, 'message').catch(error => {
      this.logger?.error('message handler failed', error)
    }))

    this.client.on('message_create', message => this._handleMessage(message, 'message_create').catch(error => {
      this.logger?.error('message_create handler failed', error)
    }))

    this.client.on('message_ack', (message, ack) => {
      const providerId = providerIdFromMessage(message)
      if (providerId) this.emit('ack', { providerId, status: ackToStatus(ack), timestamp: new Date().toISOString() })
    })
  }

  _scheduleReadyReconciliation() {
    if (this._stopping || this.state === 'ready' || this._readyReconcilePromise) return

    const epoch = this._readyReconcileEpoch
    this._readyReconcilePromise = this._reconcileReadyState({ epoch })
      .catch(error => {
        this.logger?.warn?.(`Ready reconciliation failed: ${error.message}`)
      })
      .finally(() => {
        this._readyReconcilePromise = null
      })
  }

  async _reconcileReadyState({ epoch = this._readyReconcileEpoch, attempts = 30, intervalMs = 1000 } = {}) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (this._stopping || epoch !== this._readyReconcileEpoch) return false
      if (this.state === 'ready') return true

      try {
        const socketState = typeof this.client?.getState === 'function'
          ? await this.client.getState()
          : null

        let runtimeReady = socketState === 'CONNECTED'

        if (runtimeReady && typeof this.client?.pupPage?.evaluate === 'function') {
          const probe = await this.client.pupPage.evaluate(() => {
            let hasSynced = false
            try {
              hasSynced = Boolean(window.require('WAWebSocketModel').Socket?.hasSynced)
            } catch {}

            return {
              hasWWebJS: typeof window.WWebJS !== 'undefined',
              hasSynced
            }
          })

          runtimeReady = Boolean(probe?.hasWWebJS && probe?.hasSynced)
        }

        if (runtimeReady) {
          this.readyAtMs = this.readyAtMs || Date.now()
          if (this.state !== 'ready') {
            this.setState('ready', { reconciled: true })
          }
          return true
        }
      } catch (error) {
        this.logger?.warn?.(`Ready probe ${attempt + 1}/${attempts} failed: ${error.message}`)
      }

      if (attempt + 1 < attempts && intervalMs > 0) {
        await new Promise(resolve => setTimeout(resolve, intervalMs))
      }
    }

    return false
  }
  async _tryResolveLid(lid, message) {
    const cached = this.lidToPhone.get(lid)
    if (cached) return cached

    if (typeof this.client?.getContactLidAndPhone === 'function') {
      try {
        const rows = await this.client.getContactLidAndPhone([lid])
        const row = Array.isArray(rows) ? rows[0] : null
        const phone = canonicalPhone(row?.pn)
        if (phone) {
          await this._rememberIdentity(row?.lid || lid, phone, 'getContactLidAndPhone')
          return phone
        }
      } catch (error) {
        this.logger?.warn?.(`LID lookup failed for ${lid}: ${error.message}`)
      }
    }

    // Secondary fallback. Upstream contact resolution is known to be flaky, so
    // this is deliberately best-effort and never allowed to invent a phone.
    if (typeof message?.getContact === 'function') {
      try {
        const contact = await message.getContact()
        const candidates = [
          contact?.phoneNumber?._serialized,
          contact?.phoneNumber?.$1,
          contact?.id?._serialized,
          contact?.id?.$1,
          contact?.number
        ]
        for (const candidate of candidates) {
          const phone = canonicalPhone(candidate)
          if (phone) {
            await this._rememberIdentity(lid, phone, 'message.getContact')
            return phone
          }
        }
      } catch (error) {
        this.logger?.warn?.(`Contact fallback failed for ${lid}: ${error.message}`)
      }
    }

    return null
  }

  _contactInfoFromContact(contact, phone, jid, source = 'unknown') {
    if (!contact || !phone) return null

    const clean = value => {
      const text = String(value || '').trim()
      return text || null
    }

    const name = clean(contact.name)
    const pushname = clean(contact.pushname)
    const shortName = clean(contact.shortName)
    const verifiedName = clean(contact.verifiedName)
    const displayName = name || pushname || verifiedName || shortName || null

    if (!displayName) return null

    return {
      phone,
      jid: jid || contact?.id?._serialized || contact?.id?.$1 || null,
      displayName,
      name,
      pushname,
      shortName,
      verifiedName,
      isMyContact: Boolean(contact.isMyContact),
      isMe: Boolean(contact.isMe),
      source,
      updatedAt: new Date().toISOString()
    }
  }

  async listUnreadChats({ includeMessages = true, maxMessagesPerChat = 500 } = {}) {
    const limit = Math.max(1, Math.min(Number(maxMessagesPerChat) || 500, 2000))

    // Current WhatsApp Web can contain chat models that make
    // whatsapp-web.js Client.getChats() fail while serializing the whole
    // collection. Read the already-loaded WA collection directly instead.
    if (this.client?.pupPage?.evaluate) {
      return this.client.pupPage.evaluate(async ({ includeMessages, limit }) => {
        const collections = window.require('WAWebCollections')
        const chatCollection = collections.Chat
        const rawModels = chatCollection?._models

        const chats = Array.isArray(rawModels)
          ? rawModels
          : rawModels && typeof rawModels.values === 'function'
            ? [...rawModels.values()]
            : rawModels && typeof rawModels === 'object'
              ? Object.values(rawModels)
              : []

        let loader = null
        try {
          loader = window.require('WAWebChatLoadMessages')
        } catch {}

        const serializeId = value => {
          if (!value) return null
          if (typeof value === 'string') return value
          return value._serialized || value.$1 || value.id || null
        }

        const getModels = chat => {
          try {
            if (typeof chat?.msgs?.getModelsArray === 'function') {
              return chat.msgs.getModelsArray()
            }
          } catch {}
          return []
        }

        const isInboundMessage = message => {
          try {
            if (message?.isNotification) return false
            if (message?.id?.fromMe === true) return false
            if (message?.fromMe === true) return false
            return true
          } catch {
            return false
          }
        }

        const messageTimestamp = message =>
          Number(message?.t || message?.timestamp || 0) || 0

        const uniqueInboundMessages = messages => {
          const byKey = new Map()

          for (const message of messages) {
            if (!isInboundMessage(message)) continue

            const id = serializeId(message?.id)
            const fallbackKey = [
              messageTimestamp(message),
              serializeId(message?.author),
              serializeId(message?.from),
              typeof message?.body === 'string' ? message.body : ''
            ].join('|')

            const key = id || fallbackKey
            if (!byKey.has(key)) byKey.set(key, message)
          }

          return [...byKey.values()]
            .sort((a, b) => messageTimestamp(a) - messageTimestamp(b))
        }

        const safeBody = message => {
          const type = String(message?.type || '')
          const body =
            typeof message?.body === 'string'
              ? message.body
              : typeof message?.caption === 'string'
                ? message.caption
                : ''

          if (!body) return ''

          const trimmed = body.trim()
          const compact = trimmed.replace(/\s+/g, '')

          const mediaTypes = new Set([
            'image',
            'video',
            'audio',
            'ptt',
            'sticker',
            'document'
          ])

          const looksLikeBase64 =
            compact.length >= 256 &&
            /^[A-Za-z0-9+/]+={0,2}$/.test(compact)

          const knownMediaBase64Prefix =
            compact.startsWith('/9j/') ||
            compact.startsWith('iVBORw0KGgo') ||
            compact.startsWith('R0lGOD') ||
            compact.startsWith('UklGR') ||
            compact.startsWith('AAAAIGZ0eXB') ||
            compact.startsWith('SUQz') ||
            compact.startsWith('T2dnUw')

          const dataUri = /^data:[^;]+;base64,/i.test(trimmed)

          if (
            dataUri ||
            knownMediaBase64Prefix ||
            (mediaTypes.has(type) && looksLikeBase64) ||
            (looksLikeBase64 && compact.length >= 512)
          ) {
            return ''
          }

          return body
        }

        const rows = []

        for (const chat of chats) {
          const unreadCount = Number(chat?.unreadCount || 0)
          if (!Number.isFinite(unreadCount) || unreadCount <= 0) continue

          const jid = serializeId(chat?.id)
          const targetMessageCount = Math.min(unreadCount, limit)
          let messages = []

          if (includeMessages && targetMessageCount > 0) {
            messages = getModels(chat)

            let uniqueInbound = uniqueInboundMessages(messages)
            let attempts = 0

            while (
              uniqueInbound.length < targetMessageCount &&
              loader?.loadEarlierMsgs &&
              attempts < 50
            ) {
              attempts += 1

              let loaded = null
              try {
                loaded = await loader.loadEarlierMsgs({ chat })
              } catch {
                break
              }

              if (!loaded || !loaded.length) break

              messages = [...loaded, ...messages]
              uniqueInbound = uniqueInboundMessages(messages)
            }
          }

          const normalizedMessages = includeMessages
            ? uniqueInboundMessages(messages)
                .slice(-targetMessageCount)
                .map(message => ({
                  id: serializeId(message?.id),
                  from: serializeId(message?.from) || serializeId(message?.id?.remote),
                  author: serializeId(message?.author) || null,
                  body: safeBody(message),
                  type: message?.type || null,
                  timestamp: messageTimestamp(message) || null,
                  fromMe: false
                }))
            : []

          rows.push({
            jid,
            name:
              String(
                chat?.name ||
                chat?.formattedTitle ||
                chat?.contact?.name ||
                chat?.contact?.pushname ||
                chat?.contact?.verifiedName ||
                jid ||
                'Unknown chat'
              ).trim(),
            isGroup: Boolean(jid?.endsWith('@g.us') || chat?.isGroup),
            unreadCount,
            timestamp: Number(chat?.t || chat?.timestamp || 0) || null,
            messages: normalizedMessages
          })
        }

        rows.sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
        return rows
      }, { includeMessages: Boolean(includeMessages), limit })
    }

    // Lightweight fallback used by tests/providers without a Puppeteer page.
    if (!this.client || typeof this.client.getChats !== 'function') return []

    const chats = await this.client.getChats()
    const unreadChats = []

    for (const chat of chats) {
      const unreadCount = Number(chat?.unreadCount || 0)
      if (!Number.isFinite(unreadCount) || unreadCount <= 0) continue

      const jid = chat?.id?._serialized || null
      const targetMessageCount = Math.min(unreadCount, limit)
      let messages = []

      if (includeMessages && typeof chat?.fetchMessages === 'function') {
        messages = await chat.fetchMessages({ limit: targetMessageCount })
      }

      unreadChats.push({
        jid,
        name: String(chat?.name || '').trim() || jid || 'Unknown chat',
        isGroup: Boolean(chat?.isGroup || jid?.endsWith('@g.us')),
        unreadCount,
        timestamp: Number(chat?.timestamp || 0) || null,
        messages: messages
          .filter(message => !message?.fromMe)
          .slice(-targetMessageCount)
          .map(message => ({
            id: message?.id?._serialized || null,
            from: message?.from || null,
            author: message?.author || null,
            body: typeof message?.body === 'string' ? message.body : '',
            type: message?.type || null,
            timestamp: Number(message?.timestamp || 0) || null,
            fromMe: false
          }))
      })
    }

    unreadChats.sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
    return unreadChats
  }

  async resolveContactInfo(phone, jid, message = null) {
    if (!phone || !this.client) return null

    const attempts = []

    if (typeof message?.getContact === 'function') {
      attempts.push(async () => {
        const contact = await message.getContact()
        return this._contactInfoFromContact(contact, phone, jid, 'message.getContact')
      })
    }

    if (typeof this.client.getContactById === 'function') {
      const ids = [...new Set([
        jid,
        this.phoneToLid.get(phone),
        `${phone}@c.us`
      ].filter(Boolean).map(String))]

      for (const id of ids) {
        attempts.push(async () => {
          const contact = await this.client.getContactById(id)
          return this._contactInfoFromContact(contact, phone, jid || id, `getContactById:${id}`)
        })
      }
    }

    for (const attempt of attempts) {
      try {
        const info = await attempt()
        if (info?.displayName) return info
      } catch (error) {
        this.logger?.warn?.(`Contact-name lookup failed for ${phone}: ${error.message}`)
      }
    }

    // Some WhatsApp accounts expose no saved name, pushname or verified name.
    // In that case, keep an explicit display label from the chat instead of
    // inventing a person's identity. This is commonly a formatted phone number.
    if (typeof this.client.getChatById === 'function') {
      const ids = [...new Set([
        jid,
        this.phoneToLid.get(phone),
        `${phone}@c.us`
      ].filter(Boolean).map(String))]

      for (const id of ids) {
        try {
          const chat = await this.client.getChatById(id)
          const displayName = String(chat?.name || chat?.formattedTitle || '').trim()
          if (!displayName) continue

          return {
            phone,
            jid: jid || id,
            displayName,
            name: null,
            pushname: null,
            shortName: null,
            verifiedName: null,
            isMyContact: Boolean(chat?.contact?.isMyContact),
            isMe: Boolean(chat?.contact?.isMe),
            source: `getChatById:${id}`,
            updatedAt: new Date().toISOString()
          }
        } catch (error) {
          this.logger?.warn?.(`Chat-title lookup failed for ${phone}: ${error.message}`)
        }
      }
    }

    return null
  }

  _uniquePendingByText(text) {
    const now = Date.now()
    const candidates = this.pending.filter(p =>
      !p.resolved &&
      p.text === text &&
      now - p.createdAt <= 15000
    )
    return candidates.length === 1 ? candidates[0] : null
  }

  async _resolveMessagePhone(jid, message, direction, text) {
    const direct = phoneFromJid(jid)
    if (direct) return direct
    if (jidKind(jid) !== 'lid') return null

    const mapped = await this._tryResolveLid(jid, message)
    if (mapped) return mapped

    // Crucial send-correlation fallback for modern WA Web: message_create may
    // expose the recipient only as @lid while sendMessage was called with @c.us.
    // If exactly one pending send has this text, it is safe to bind that LID.
    if (direction === 'out') {
      const pending = this._uniquePendingByText(text)
      if (pending) {
        await this._rememberIdentity(jid, pending.phone, 'pending-send-correlation')
        return pending.phone
      }
    }

    return null
  }

  _rememberSeen(providerId) {
    if (!providerId) return
    this.seenProviderIds.add(providerId)
    if (this.seenProviderIds.size > 5000) {
      const remove = this.seenProviderIds.size - 4000
      const iterator = this.seenProviderIds.values()
      for (let i = 0; i < remove; i += 1) {
        const next = iterator.next()
        if (next.done) break
        this.seenProviderIds.delete(next.value)
      }
    }
  }

  async _handleMessage(message, source = 'unknown') {
    const jid = message.fromMe ? message.to : message.from
    if (!jid) return
    if (isIgnoredJid(jid)) return
    if (isGroupJid(jid) && !this.allowGroups) return

    const providerId = providerIdFromMessage(message) || `wwebjs-event-${crypto.randomUUID()}`
    if (this.seenProviderIds.has(providerId)) return

    const direction = message.fromMe ? 'out' : 'in'
    const text = message.body || ''
    const messageTimeMs = message.timestamp ? Number(message.timestamp) * 1000 : Date.now()
    const timestamp = new Date(messageTimeMs).toISOString()
    const historical = Boolean(
      direction === 'in' &&
      this.readyAtMs &&
      messageTimeMs < this.readyAtMs - 120000
    )
    const phone = await this._resolveMessagePhone(jid, message, direction, text)

    if (!phone) {
      // Initial WhatsApp sync can replay old history. Unresolved historical
      // records are diagnostic noise, not actionable replies.
      if (!historical) {
        this.emit('unresolved_message', {
          providerId,
          jid,
          direction,
          text,
          timestamp,
          source,
          historical,
          reason: jidKind(jid) === 'lid' ? 'lid_unresolved' : 'jid_unresolved'
        })
      }
      return
    }

    this._rememberSeen(providerId)

    const contact = await this.resolveContactInfo(phone, jid, message)

    const payload = {
      providerId,
      phone,
      jid,
      direction,
      text,
      timestamp,
      historical,
      status: direction === 'in' ? 'received' : 'sent',
      unread: direction === 'in' && !historical,
      contact
    }

    if (contact) this.emit('contact', contact)

    if (direction === 'in') {
      this.lastInboundByPhone.set(phone, message)
      this.emit('message', payload)
      return
    }

    const pending = this.pending.find(p => !p.resolved && p.phone === phone && p.text === payload.text)
    if (pending) {
      pending.resolved = true
      pending.resolve({ providerId, confirmed: true, jid, timestamp: payload.timestamp })
    }

    this.emit('message', payload)
  }

  // Backwards-compatible test hook used by v1 tests and external diagnostics.
  async _onMessageCreate(message) {
    return this._handleMessage(message, 'message_create')
  }

  getStatus() {
    return {
      ...super.getStatus(),
      identityMappings: this.lidToPhone.size
    }
  }

  async resolveRecipient(phone) {
    if (!this.client) throw new Error('Provider not started')

    // Prefer the provider's canonical number resolver when available. It can
    // return an @lid on modern accounts, giving us an authoritative binding.
    if (typeof this.client.getNumberId === 'function') {
      try {
        const id = await this.client.getNumberId(phone)
        if (id) {
          const resolvedJid = String(id._serialized || id.$1 || id)
          if (jidKind(resolvedJid) === 'lid') await this._rememberIdentity(resolvedJid, phone, 'getNumberId')
          return { registered: true, jid: resolvedJid }
        }
      } catch (error) {
        this.logger?.warn?.(`getNumberId failed for ${phone}; falling back to isRegisteredUser: ${error.message}`)
      }
    }

    const jid = `${phone}@c.us`
    const registered = await this.client.isRegisteredUser(jid)
    return { registered, jid }
  }

  async sendText(phone, text) {
    if (this.state !== 'ready') throw new Error(`Provider not ready: ${this.state}`)

    // resolveRecipient() runs immediately before sendText() in the service.
    // Modern WhatsApp accounts may require the authoritative @lid JID.
    // Reuse a learned mapping instead of blindly rebuilding @c.us.
    const jid = this.phoneToLid.get(phone) || `${phone}@c.us`

    let pendingResolve
    const eventPromise = new Promise(resolve => { pendingResolve = resolve })
    const pending = { phone, text, resolve: pendingResolve, resolved: false, createdAt: Date.now() }
    this.pending.push(pending)

    try {
      const sent = await this.client.sendMessage(jid, text)
      const providerId = providerIdFromMessage(sent)
      if (providerId) {
        const remoteJid = remoteJidFromMessage(sent) || jid
        if (jidKind(remoteJid) === 'lid') await this._rememberIdentity(remoteJid, phone, 'sendMessage-result')
        pending.resolved = true
        return { providerId, confirmed: true, jid: remoteJid, timestamp: new Date().toISOString() }
      }

      const eventResult = await Promise.race([
        eventPromise,
        new Promise(resolve => setTimeout(() => resolve(null), 3500))
      ])

      if (eventResult) return eventResult

      return {
        providerId: `wwebjs-local-${crypto.randomUUID()}`,
        confirmed: false,
        jid,
        timestamp: new Date().toISOString()
      }
    } finally {
      setTimeout(() => {
        const idx = this.pending.indexOf(pending)
        if (idx >= 0) this.pending.splice(idx, 1)
      }, 7000).unref?.()
    }
  }

  async markRead(phone) {
    const message = this.lastInboundByPhone.get(phone)
    if (!message) return 0
    try {
      const chat = await message.getChat()
      await chat.sendSeen()
      return 1
    } catch {
      return 0
    }
  }

  async stop() {
    this._stopping = true
    this._readyReconcileEpoch += 1
    if (this.client) {
      try { await this.client.destroy() } catch {}
    }
    this.setState('stopped')
  }
}


