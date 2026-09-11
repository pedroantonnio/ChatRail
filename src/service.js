import crypto from 'node:crypto'
import { AppError } from './errors.js'
import { normalizePhone, hasUnicodeReplacement } from './normalize.js'

export const SERVICE_VERSION = '1.0.0'

function hashText(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex')
}

export class WhatsAppService {
  constructor({ config, store, provider, logger }) {
    this.config = config
    this.store = store
    this.provider = provider
    this.logger = logger
    this.locks = new Map()
    this._contactSyncPromise = null
    this.startedAt = new Date().toISOString()
    this._bindProvider()
  }

  _bindProvider() {
    this.provider.on('message', async message => {
      try {
        const replyEligible = this.store.isReplyEligible(message)
        const normalized = {
          ...message,
          replyEligible,
          unread: Boolean(message.direction === 'in' && message.unread && replyEligible)
        }

        if (message.contact?.displayName) {
          await this.store.upsertContact(message.contact)
        }

        const { contact: _contact, ...persistedMessage } = normalized
        await this.store.addMessage({
          id: `msg-${crypto.randomUUID()}`,
          createdAt: new Date().toISOString(),
          ...persistedMessage
        })
        await this.store.addEvent({
          id: `evt-${crypto.randomUUID()}`,
          type: message.direction === 'in' ? 'message.received' : 'message.outgoing_observed',
          phone: message.phone,
          providerId: message.providerId,
          replyEligible,
          historical: Boolean(message.historical),
          timestamp: new Date().toISOString()
        })
      } catch (error) {
        this.logger?.error('Failed to persist provider message', error)
      }
    })

    this.provider.on('unresolved_message', async message => {
      try {
        await this.store.addUnresolvedMessage({
          id: `unresolved-${crypto.randomUUID()}`,
          createdAt: new Date().toISOString(),
          ...message
        })
        await this.store.addEvent({
          id: `evt-${crypto.randomUUID()}`,
          type: 'message.unresolved_identity',
          jid: message.jid,
          providerId: message.providerId,
          direction: message.direction,
          reason: message.reason,
          timestamp: new Date().toISOString()
        })
      } catch (error) {
        this.logger?.error('Failed to persist unresolved provider message', error)
      }
    })

    this.provider.on('contact', contact => {
      this.store.upsertContact(contact)
        .catch(error => this.logger?.error('Failed to persist contact metadata', error))
    })
    this.provider.on('identity', identity => {
      Promise.all([
        this.store.bindRecipientJid(identity.phone, identity.lid),
        this.store.addEvent({
          id: `evt-${crypto.randomUUID()}`,
          type: 'identity.mapped',
          ...identity
        })
      ]).catch(error => this.logger?.error('Failed to persist identity map event', error))
    })

    this.provider.on('identity_conflict', conflict => {
      this.store.addEvent({
        id: `evt-${crypto.randomUUID()}`,
        type: 'identity.conflict',
        ...conflict
      }).catch(error => this.logger?.error('Failed to persist identity conflict event', error))
    })

    this.provider.on('ack', async ack => {
      try {
        await this.store.updateMessageByProviderId(ack.providerId, {
          status: ack.status,
          statusUpdatedAt: ack.timestamp || new Date().toISOString()
        })
        await this.store.addEvent({
          id: `evt-${crypto.randomUUID()}`,
          type: 'message.ack',
          providerId: ack.providerId,
          status: ack.status,
          timestamp: ack.timestamp || new Date().toISOString()
        })
      } catch (error) {
        this.logger?.error('Failed to persist ack', error)
      }
    })

    this.provider.on('status', status => {
      this.store.addEvent({
        id: `evt-${crypto.randomUUID()}`,
        type: 'provider.status',
        ...status
      }).catch(error => this.logger?.error('Failed to persist status', error))

      if (status?.state === 'ready') {
        this._syncContactNames()
          .catch(error => this.logger?.error('Failed to sync contact names', error))
      }
    })
  }

  async _syncContactNames() {
    if (this._contactSyncPromise) return this._contactSyncPromise
    if (typeof this.provider.resolveContactInfo !== 'function') return 0

    this._contactSyncPromise = (async () => {
      const targets = new Map()

      for (const message of this.store.listMessages({ limit: 1000 })) {
        if (!message?.phone) continue
        const current = targets.get(message.phone) || { phone: message.phone, jid: null }
        if (message.jid) current.jid = message.jid
        targets.set(message.phone, current)
      }

      let updated = 0
      for (const target of targets.values()) {
        const contact = await this.provider.resolveContactInfo(target.phone, target.jid)
        if (!contact?.displayName) continue
        await this.store.upsertContact(contact)
        updated += 1
      }

      return updated
    })().finally(() => {
      this._contactSyncPromise = null
    })

    return this._contactSyncPromise
  }
  status() {
    return {
      service: 'chatrail',
      version: SERVICE_VERSION,
      startedAt: this.startedAt,
      provider: this.provider.getStatus(),
      safeguards: {
        allowUnregistered: this.config.allowUnregistered,
        allowGroups: this.config.allowGroups,
        dedupeWindowHours: this.config.dedupeWindowHours
      },
      counts: {
        recipients: this.store.listRecipients().length,
        messages: this.store.listMessages({ limit: 1000 }).length,
        unreadReplies: this.store.listReplies({ unreadOnly: true, limit: 1000 }).length,
        unresolvedMessages: this.store.listUnresolvedMessages({ limit: 1000 }).length
      }
    }
  }

  async registerRecipient(input) {
    const phone = normalizePhone(input.phone, this.config.defaultCountryCode)
    const name = String(input.name || '').trim()
    const source = String(input.source || '').trim()
    const notes = String(input.notes || '').trim()
    const tags = Array.isArray(input.tags) ? input.tags.map(value => String(value).trim()).filter(Boolean) : []

    if ([name, source, notes, ...tags].some(hasUnicodeReplacement)) {
      throw new AppError('recipient metadata contains Unicode replacement characters; resend the request as valid UTF-8', {
        status: 400,
        code: 'TEXT_ENCODING_INVALID'
      })
    }

    return this.store.registerRecipient({
      phone,
      name,
      tags,
      source,
      notes,
      registeredAt: new Date().toISOString()
    })
  }

  async _withLock(key, fn) {
    while (this.locks.has(key)) await this.locks.get(key)
    let release
    const promise = new Promise(resolve => { release = resolve })
    this.locks.set(key, promise)
    try {
      return await fn()
    } finally {
      this.locks.delete(key)
      release()
    }
  }

  async send(input) {
    const phone = normalizePhone(input.phone, this.config.defaultCountryCode)
    const text = String(input.text || '')
    if (!text.trim()) throw new AppError('text is required', { code: 'TEXT_REQUIRED' })
    if (text.length > 10000) throw new AppError('text exceeds 10000 characters', { code: 'TEXT_TOO_LONG' })

    const recipient = this.store.getRecipient(phone)
    if (!recipient && !this.config.allowUnregistered) {
      throw new AppError('Recipient is not registered. POST /recipients first.', {
        status: 403,
        code: 'UNREGISTERED_RECIPIENT'
      })
    }

    const textHash = hashText(text)
    const idempotencyKey = input.idempotencyKey ? String(input.idempotencyKey) : ''
    const lockKey = `${phone}:${idempotencyKey || textHash}`

    return this._withLock(lockKey, async () => {
      if (idempotencyKey) {
        const existing = this.store.findSendByIdempotencyKey(idempotencyKey)
        if (existing) {
          if (existing.phone !== phone || existing.textHash !== textHash) {
            throw new AppError('Idempotency key was already used with a different request', {
              status: 409,
              code: 'IDEMPOTENCY_CONFLICT'
            })
          }
          return { ok: true, duplicate: true, send: existing }
        }
      }

      const sinceMs = Date.now() - this.config.dedupeWindowHours * 3600_000
      const duplicate = this.store.findDuplicateSend({ phone, textHash, sinceMs })
      if (duplicate && !input.force) {
        return { ok: true, duplicate: true, send: duplicate }
      }

      const sendId = `send-${crypto.randomUUID()}`
      const base = {
        id: sendId,
        phone,
        recipientName: recipient?.name || null,
        text,
        textHash,
        idempotencyKey,
        createdAt: new Date().toISOString()
      }

      if (input.dryRun) {
        const record = { ...base, status: 'dry_run', provider: this.provider.providerName }
        await this.store.recordSend(record)
        return { ok: true, duplicate: false, dryRun: true, send: record }
      }

      if (!this.provider.getStatus().ready) {
        throw new AppError(`WhatsApp provider is not ready: ${this.provider.getStatus().state}`, {
          status: 503,
          code: 'PROVIDER_NOT_READY'
        })
      }

      const providerRecipient = await this.provider.resolveRecipient(phone)
      if (!providerRecipient.registered) {
        throw new AppError('Public phone is not registered on WhatsApp according to provider', {
          status: 422,
          code: 'WHATSAPP_NOT_REGISTERED'
        })
      }

      let result
      try {
        result = await this.provider.sendText(phone, text)
      } catch (error) {
        const failed = {
          ...base,
          provider: this.provider.providerName,
          status: 'failed',
          failure: String(error.message || error)
        }
        await this.store.recordSend(failed)
        throw new AppError(`Provider send failed: ${error.message || error}`, {
          status: 502,
          code: 'PROVIDER_SEND_FAILED'
        })
      }

      const status = result.confirmed ? 'sent' : 'submitted_unconfirmed'
      const record = {
        ...base,
        provider: this.provider.providerName,
        providerId: result.providerId,
        jid: result.jid,
        providerConfirmed: Boolean(result.confirmed),
        status,
        sentAt: result.timestamp || new Date().toISOString()
      }
      await this.store.recordSend(record)
      await this.store.activateReplyWatch(phone, {
        startedAt: record.sentAt,
        sendId: record.id,
        jid: result.jid
      })
      await this.store.addMessage({
        id: `msg-${crypto.randomUUID()}`,
        providerId: result.providerId,
        phone,
        jid: result.jid,
        direction: 'out',
        text,
        timestamp: record.sentAt,
        createdAt: new Date().toISOString(),
        status,
        unread: false
      })
      await this.store.addEvent({
        id: `evt-${crypto.randomUUID()}`,
        type: 'message.sent',
        phone,
        providerId: result.providerId,
        confirmed: Boolean(result.confirmed),
        timestamp: new Date().toISOString()
      })

      return { ok: true, duplicate: false, send: record }
    })
  }

  async listUnreadChats({ includeMessages = true, maxMessagesPerChat = 500 } = {}) {
    const status = this.provider.getStatus?.() || {}
    if (!status.ready) {
      throw new AppError(`WhatsApp provider is not ready: ${status.state || 'unknown'}`, {
        status: 503,
        code: 'PROVIDER_NOT_READY'
      })
    }

    if (typeof this.provider.listUnreadChats !== 'function') {
      throw new AppError('Provider does not support live unread chat listing', {
        status: 501,
        code: 'UNREAD_NOT_SUPPORTED'
      })
    }

    const chats = await this.provider.listUnreadChats({
      includeMessages,
      maxMessagesPerChat
    })

    return {
      chats,
      unreadChatCount: chats.length,
      totalUnreadMessages: chats.reduce(
        (sum, chat) => sum + Number(chat.unreadCount || 0),
        0
      )
    }
  }

  async markRead(phoneInput) {
    const phone = normalizePhone(phoneInput, this.config.defaultCountryCode)
    const providerCount = await this.provider.markRead(phone)
    const localCount = await this.store.markRead(phone)
    return { phone, providerCount, localCount }
  }
}
