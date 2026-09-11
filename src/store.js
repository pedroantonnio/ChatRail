import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

function initialData() {
  return {
    schemaVersion: 5,
    recipients: {},
    contacts: {},
    messages: [],
    sends: [],
    events: [],
    unresolvedMessages: []
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function timeMs(value) {
  const n = new Date(value || 0).getTime()
  return Number.isFinite(n) ? n : 0
}

function isRealSend(send) {
  return send && !['failed', 'dry_run'].includes(send.status)
}

function isBroadcastLike(jid) {
  const value = String(jid || '').toLowerCase()
  return value === 'status@broadcast' || value.endsWith('@broadcast') || value.endsWith('@newsletter')
}

export class JsonStore {
  constructor(filePath) {
    this.filePath = filePath
    this.data = initialData()
    this.loaded = false
    this._writeChain = Promise.resolve()
  }

  async load() {
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true })
    let migrated = false
    if (fs.existsSync(this.filePath)) {
      const raw = await fs.promises.readFile(this.filePath, 'utf8')
      if (raw.trim()) {
        const parsed = JSON.parse(raw)
        this.data = { ...initialData(), ...parsed }
        if (parsed.recipients && typeof parsed.recipients === 'object') {
          this.data.recipients = parsed.recipients
        } else if (parsed.prospects && typeof parsed.prospects === 'object') {
          this.data.recipients = parsed.prospects
          migrated = true
        }
        delete this.data.prospects
        this.data.recipients ||= {}
        this.data.contacts ||= {}
        this.data.messages ||= []
        this.data.sends ||= []
        this.data.events ||= []
        this.data.unresolvedMessages ||= []

        // v1.2 migration: status/newsletter sync is not actionable messaging data.
        const before = this.data.unresolvedMessages.length
        this.data.unresolvedMessages = this.data.unresolvedMessages.filter(m => !isBroadcastLike(m.jid))
        if (before !== this.data.unresolvedMessages.length) migrated = true

        for (const recipient of Object.values(this.data.recipients)) {
          recipient.boundJids = Array.isArray(recipient.boundJids) ? [...new Set(recipient.boundJids.map(String))] : []
        }

        if (Number(this.data.schemaVersion || 0) < 3) {
          // Legacy v1/v1.1 inbound rows were marked unread even when replayed
          // from old chat history. Never promote those rows into tracked replies.
          for (const message of this.data.messages) {
            if (message.direction === 'in' && message.replyEligible === undefined) {
              message.replyEligible = false
              message.unread = false
            }
          }
          this.data.schemaVersion = 3
          migrated = true
        }

        if (Number(this.data.schemaVersion || 0) < 4) {
          this.data.contacts ||= {}
          this.data.schemaVersion = 4
          migrated = true
        }

        if (Number(this.data.schemaVersion || 0) < 5) {
          this.data.recipients ||= {}
          delete this.data.prospects
          this.data.schemaVersion = 5
          migrated = true
        }
      }
    } else {
      await this._persist()
    }
    this.loaded = true
    if (migrated) await this._persist()
    return this
  }

  async _persist() {
    const snapshot = JSON.stringify(this.data, null, 2)
    const tmp = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
    this._writeChain = this._writeChain.then(async () => {
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true })
      await fs.promises.writeFile(tmp, snapshot, 'utf8')
      await fs.promises.rename(tmp, this.filePath)
    })
    return this._writeChain
  }

  async registerRecipient(recipient) {
    const existing = this.data.recipients[recipient.phone] || null
    const boundJids = [...new Set([
      ...(Array.isArray(existing?.boundJids) ? existing.boundJids : []),
      ...(Array.isArray(recipient.boundJids) ? recipient.boundJids : [])
    ].filter(Boolean).map(String))]

    this.data.recipients[recipient.phone] = {
      ...(existing || {}),
      ...recipient,
      // Re-registering metadata must not reset the reply epoch.
      registeredAt: existing?.registeredAt || recipient.registeredAt,
      replyWatchStartedAt: existing?.replyWatchStartedAt || recipient.replyWatchStartedAt || null,
      firstOutboundSendId: existing?.firstOutboundSendId || recipient.firstOutboundSendId || null,
      boundJids
    }
    await this._persist()
    return clone(this.data.recipients[recipient.phone])
  }

  getRecipient(phone) {
    const value = this.data.recipients[phone]
    return value ? clone(value) : null
  }

  listRecipients() {
    return Object.values(this.data.recipients).map(clone)
  }
  async upsertContact(contact) {
    const phone = String(contact?.phone || '').trim()
    if (!phone) return null

    const existing = this.data.contacts[phone] || null
    const next = {
      ...(existing || {}),
      ...contact,
      phone,
      updatedAt: contact?.updatedAt || new Date().toISOString()
    }

    const same = existing && JSON.stringify(existing) === JSON.stringify(next)
    if (same) return clone(existing)

    this.data.contacts[phone] = next
    await this._persist()
    return clone(next)
  }

  getContact(phone) {
    const value = this.data.contacts[String(phone || '')]
    return value ? clone(value) : null
  }

  listContacts() {
    return Object.values(this.data.contacts).map(clone)
  }

  async activateReplyWatch(phone, { startedAt, sendId, jid } = {}) {
    const recipient = this.data.recipients[phone]
    if (!recipient) return null

    if (!recipient.replyWatchStartedAt) recipient.replyWatchStartedAt = startedAt || new Date().toISOString()
    if (!recipient.firstOutboundSendId && sendId) recipient.firstOutboundSendId = String(sendId)
    recipient.boundJids = Array.isArray(recipient.boundJids) ? recipient.boundJids : []
    if (jid && !recipient.boundJids.includes(String(jid))) recipient.boundJids.push(String(jid))

    await this._persist()
    return clone(recipient)
  }

  async bindRecipientJid(phone, jid) {
    if (!phone || !jid) return false
    const recipient = this.data.recipients[phone]
    if (!recipient) return false
    recipient.boundJids = Array.isArray(recipient.boundJids) ? recipient.boundJids : []
    if (recipient.boundJids.includes(String(jid))) return false
    recipient.boundJids.push(String(jid))
    await this._persist()
    return true
  }

  async recordSend(send) {
    const existingIndex = this.data.sends.findIndex(s => s.id === send.id)
    if (existingIndex >= 0) this.data.sends[existingIndex] = { ...this.data.sends[existingIndex], ...send }
    else this.data.sends.push({ ...send })
    await this._persist()
    return clone(send)
  }

  listSends({ phone, limit = 100 } = {}) {
    let rows = this.data.sends
    if (phone) rows = rows.filter(s => s.phone === phone)
    return rows.slice(-Math.max(1, Math.min(Number(limit) || 100, 1000))).map(clone)
  }

  findSendByIdempotencyKey(key) {
    if (!key) return null
    const found = this.data.sends.find(s => s.idempotencyKey === key)
    return found ? clone(found) : null
  }

  findDuplicateSend({ phone, textHash, sinceMs }) {
    const found = [...this.data.sends].reverse().find(s =>
      s.phone === phone &&
      s.textHash === textHash &&
      new Date(s.createdAt).getTime() >= sinceMs &&
      !['failed', 'dry_run'].includes(s.status)
    )
    return found ? clone(found) : null
  }

  _replyWatch(phone) {
    const recipient = this.data.recipients[phone]
    if (!recipient) return null

    let watchMs = timeMs(recipient.replyWatchStartedAt)
    let send = null

    if (!watchMs) {
      send = this.data.sends.find(s => s.phone === phone && isRealSend(s)) || null
      watchMs = timeMs(send?.sentAt || send?.createdAt)
    }

    if (!watchMs) return null
    const registeredMs = timeMs(recipient.registeredAt)
    if (registeredMs) watchMs = Math.max(watchMs, registeredMs)

    const boundJids = new Set(Array.isArray(recipient.boundJids) ? recipient.boundJids.map(String) : [])
    if (send?.jid) boundJids.add(String(send.jid))

    return {
      watchMs,
      watchAt: new Date(watchMs).toISOString(),
      boundJids: [...boundJids]
    }
  }

  isReplyEligible(message) {
    if (!message || message.direction !== 'in' || !message.phone) return false
    if (message.historical === true) return false

    const watch = this._replyWatch(message.phone)
    if (!watch) return false

    const messageMs = timeMs(message.timestamp || message.createdAt)
    if (!messageMs || messageMs < watch.watchMs - 2000) return false

    // Conversation binding prevents a future identity-map collision from making
    // another LID/chat appear as this recipient. Direct phone JIDs are accepted;
    // LIDs must be one we learned/bound for the recipient.
    if (message.jid && String(message.jid).toLowerCase().endsWith('@lid') && watch.boundJids.length) {
      if (!watch.boundJids.includes(String(message.jid))) return false
    }

    return true
  }

  replyState(phone) {
    const recipient = this.data.recipients[phone]
    if (!recipient) return null
    const watch = this._replyWatch(phone)
    const sends = this.data.sends.filter(s => s.phone === phone && isRealSend(s))
    const replies = this.data.messages.filter(m => m.phone === phone && m.direction === 'in' && m.replyEligible === true)
    return clone({
      phone,
      recipient,
      watch,
      realSendCount: sends.length,
      eligibleReplyCount: replies.length,
      unreadReplyCount: replies.filter(m => m.unread === true).length
    })
  }

  async addMessage(message) {
    const providerId = message.providerId || null
    let idx = -1
    if (providerId) idx = this.data.messages.findIndex(m => m.providerId === providerId)
    if (idx < 0 && message.id) idx = this.data.messages.findIndex(m => m.id === message.id)

    if (idx >= 0) this.data.messages[idx] = { ...this.data.messages[idx], ...message }
    else this.data.messages.push({ ...message })

    await this._persist()
    return clone(idx >= 0 ? this.data.messages[idx] : message)
  }

  async updateMessageByProviderId(providerId, patch) {
    if (!providerId) return false
    const idx = this.data.messages.findIndex(m => m.providerId === providerId)
    if (idx < 0) return false
    this.data.messages[idx] = { ...this.data.messages[idx], ...patch }
    await this._persist()
    return true
  }

  listMessages({ phone, direction, unreadOnly = false, limit = 100 } = {}) {
    let rows = this.data.messages
    if (phone) rows = rows.filter(m => m.phone === phone)
    if (direction) rows = rows.filter(m => m.direction === direction)
    if (unreadOnly) rows = rows.filter(m => m.unread === true)
    return rows
      .slice(-Math.max(1, Math.min(Number(limit) || 100, 1000)))
      .map(message => clone({
        ...message,
        contact: this.data.contacts[message.phone] || null,
        contactName: this.data.contacts[message.phone]?.displayName || null
      }))
  }

  listReplies({ unreadOnly = true, limit = 100 } = {}) {
    let rows = this.data.messages.filter(m =>
      m.direction === 'in' &&
      Boolean(this.data.recipients[m.phone]) &&
      m.replyEligible === true &&
      (!unreadOnly || m.unread === true)
    )
    return rows
      .slice(-Math.max(1, Math.min(Number(limit) || 100, 1000)))
      .map(message => clone({
        ...message,
        contact: this.data.contacts[message.phone] || null,
        contactName: this.data.contacts[message.phone]?.displayName || null
      }))
  }

  listChats({ limit = 100 } = {}) {
    const map = new Map()
    for (const message of this.data.messages) {
      const current = map.get(message.phone) || {
        phone: message.phone,
        lastMessageAt: null,
        lastText: '',
        unread: 0,
        inbound: 0,
        outbound: 0,
        recipient: this.data.recipients[message.phone] || null,
        contact: this.data.contacts[message.phone] || null,
        contactName: this.data.contacts[message.phone]?.displayName || null
      }
      current.lastMessageAt = message.timestamp || message.createdAt || current.lastMessageAt
      current.lastText = message.text || ''
      if (message.unread && message.replyEligible === true) current.unread += 1
      if (message.direction === 'in') current.inbound += 1
      if (message.direction === 'out') current.outbound += 1
      map.set(message.phone, current)
    }
    return [...map.values()]
      .sort((a, b) => new Date(b.lastMessageAt || 0) - new Date(a.lastMessageAt || 0))
      .slice(0, Math.max(1, Math.min(Number(limit) || 100, 1000)))
      .map(clone)
  }

  async markRead(phone) {
    let changed = 0
    for (const message of this.data.messages) {
      if (message.phone === phone && message.direction === 'in' && message.unread && message.replyEligible === true) {
        message.unread = false
        changed += 1
      }
    }
    if (changed) await this._persist()
    return changed
  }

  async addUnresolvedMessage(message) {
    if (isBroadcastLike(message?.jid)) return null
    const providerId = message.providerId || null
    const idx = providerId ? this.data.unresolvedMessages.findIndex(m => m.providerId === providerId) : -1
    if (idx >= 0) this.data.unresolvedMessages[idx] = { ...this.data.unresolvedMessages[idx], ...message }
    else this.data.unresolvedMessages.push({ ...message })
    if (this.data.unresolvedMessages.length > 1000) this.data.unresolvedMessages.splice(0, this.data.unresolvedMessages.length - 1000)
    await this._persist()
    return clone(idx >= 0 ? this.data.unresolvedMessages[idx] : message)
  }

  listUnresolvedMessages({ limit = 100 } = {}) {
    return this.data.unresolvedMessages
      .filter(m => !isBroadcastLike(m.jid))
      .slice(-Math.max(1, Math.min(Number(limit) || 100, 1000)))
      .map(clone)
  }

  async addEvent(event) {
    this.data.events.push({ ...event })
    if (this.data.events.length > 5000) this.data.events.splice(0, this.data.events.length - 5000)
    await this._persist()
    return clone(event)
  }

  listEvents({ since, limit = 200 } = {}) {
    let rows = this.data.events
    if (since) {
      const t = new Date(since).getTime()
      if (Number.isFinite(t)) rows = rows.filter(e => new Date(e.timestamp).getTime() >= t)
    }
    return rows.slice(-Math.max(1, Math.min(Number(limit) || 200, 1000))).map(clone)
  }

  snapshot() {
    return clone(this.data)
  }
}

