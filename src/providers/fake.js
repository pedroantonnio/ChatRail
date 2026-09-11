import crypto from 'node:crypto'
import { BaseProvider } from './base.js'

export class FakeProvider extends BaseProvider {
  constructor(options = {}) {
    super(options)
    this.providerName = 'fake'
    this.sent = []
    this.registered = new Set(options.registeredPhones || [])
    this.failSend = false
    this.sendDelayMs = 0
  }

  async start() {
    this.setState('ready')
  }

  async stop() {
    this.setState('stopped')
  }

  async resolveRecipient(phone) {
    const registered = this.registered.size === 0 || this.registered.has(phone)
    return { registered, jid: `${phone}@fake` }
  }

  async sendText(phone, text) {
    if (this.state !== 'ready') throw new Error('Fake provider not ready')
    if (this.failSend) throw new Error('Simulated provider send failure')
    if (this.sendDelayMs) await new Promise(resolve => setTimeout(resolve, this.sendDelayMs))
    const providerId = `fake-${crypto.randomUUID()}`
    const entry = { phone, text, providerId }
    this.sent.push(entry)
    return { providerId, confirmed: true, jid: `${phone}@fake`, timestamp: new Date().toISOString() }
  }

  async markRead() {
    return 1
  }

  async simulateInbound(phone, text, { providerId = `fake-in-${crypto.randomUUID()}` } = {}) {
    const message = {
      providerId,
      phone,
      jid: `${phone}@fake`,
      direction: 'in',
      text,
      timestamp: new Date().toISOString(),
      status: 'received',
      unread: true
    }
    this.emit('message', message)
    return message
  }

  simulateAck(providerId, status = 'read') {
    this.emit('ack', { providerId, status, timestamp: new Date().toISOString() })
  }
}
