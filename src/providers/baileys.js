import path from 'node:path'
import crypto from 'node:crypto'
import { BaseProvider } from './base.js'
import { phoneFromJid } from '../normalize.js'

export function extractText(message) {
  const m = message || {}
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    m.templateButtonReplyMessage?.selectedDisplayText ||
    ''
  )
}

export function statusFromNumber(value) {
  const map = {
    '0': 'error',
    '1': 'pending',
    '2': 'server',
    '3': 'delivered',
    '4': 'read',
    '5': 'played'
  }
  return map[String(value)] || `status_${value}`
}

export class BaileysProvider extends BaseProvider {
  constructor({ logger, dataDir, allowGroups = false } = {}) {
    super({ logger, allowGroups })
    this.providerName = 'baileys'
    this.dataDir = dataDir
    this.sock = null
    this.lastInboundKeys = new Map()
    this._stopping = false
  }

  async start() {
    let baileys
    let qrcode
    try {
      baileys = await import('@whiskeysockets/baileys')
      qrcode = (await import('qrcode-terminal')).default
    } catch (error) {
      throw new Error(`Baileys dependencies are not installed. Run npm install. ${error.message}`)
    }

    const {
      default: makeWASocket,
      useMultiFileAuthState,
      DisconnectReason
    } = baileys

    const authPath = path.join(this.dataDir, 'baileys-auth')
    const { state, saveCreds } = await useMultiFileAuthState(authPath)
    this._stopping = false
    this.setState('connecting')

    const sock = makeWASocket({
      auth: state,
      logger: this.logger,
      syncFullHistory: false,
      markOnlineOnConnect: false
    })

    this.sock = sock
    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', update => {
      const { connection, lastDisconnect, qr } = update
      if (qr) {
        this.setState('qr', { qrAvailable: true })
        this.logger?.info('Scan the Baileys QR code below in WhatsApp > Linked devices')
        qrcode.generate(qr, { small: true })
      }

      if (connection === 'open') this.setState('ready')
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.statusCode
        const loggedOut = code === DisconnectReason.loggedOut
        this.setState(loggedOut ? 'logged_out' : 'disconnected', { code })
        if (!loggedOut && !this._stopping) {
          setTimeout(() => this.start().catch(error => this.logger?.error('Baileys reconnect failed', error)), 1500).unref?.()
        }
      }
    })

    sock.ev.on('messages.upsert', ({ messages }) => {
      for (const msg of messages || []) {
        const jid = msg.key?.remoteJidAlt || msg.key?.remoteJid
        if (!jid || (!this.allowGroups && jid.endsWith('@g.us'))) continue
        const phone = phoneFromJid(jid)
        if (!phone) continue
        const direction = msg.key?.fromMe ? 'out' : 'in'
        const providerId = msg.key?.id || `baileys-${crypto.randomUUID()}`
        const payload = {
          providerId,
          phone,
          jid,
          direction,
          text: extractText(msg.message),
          timestamp: new Date(Number(msg.messageTimestamp || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
          status: direction === 'in' ? 'received' : 'sent',
          unread: direction === 'in'
        }
        if (direction === 'in') this.lastInboundKeys.set(phone, msg.key)
        this.emit('message', payload)
      }
    })

    sock.ev.on('messages.update', updates => {
      for (const item of updates || []) {
        const providerId = item.key?.id
        if (!providerId || item.update?.status === undefined) continue
        this.emit('ack', {
          providerId,
          status: statusFromNumber(item.update.status),
          timestamp: new Date().toISOString()
        })
      }
    })
  }

  async resolveRecipient(phone) {
    if (!this.sock) throw new Error('Provider not started')
    const result = await this.sock.onWhatsApp(phone)
    const first = Array.isArray(result) ? result[0] : null
    return {
      registered: Boolean(first?.exists),
      jid: first?.jid || `${phone}@s.whatsapp.net`
    }
  }

  async sendText(phone, text) {
    if (this.state !== 'ready') throw new Error(`Provider not ready: ${this.state}`)
    const recipient = await this.resolveRecipient(phone)
    if (!recipient.registered) throw new Error('Number is not registered on WhatsApp')
    const sent = await this.sock.sendMessage(recipient.jid, { text })
    const providerId = sent?.key?.id || `baileys-local-${crypto.randomUUID()}`
    return {
      providerId,
      confirmed: Boolean(sent?.key?.id),
      jid: recipient.jid,
      timestamp: new Date().toISOString()
    }
  }

  async markRead(phone) {
    const key = this.lastInboundKeys.get(phone)
    if (!key || !this.sock) return 0
    await this.sock.readMessages([key])
    return 1
  }

  async stop() {
    this._stopping = true
    try { this.sock?.end?.(new Error('stopped')) } catch {}
    this.setState('stopped')
  }
}
