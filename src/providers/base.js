import { EventEmitter } from 'node:events'

export class BaseProvider extends EventEmitter {
  constructor({ logger, allowGroups = false } = {}) {
    super()
    this.logger = logger
    this.allowGroups = allowGroups
    this.state = 'idle'
    this.providerName = 'base'
  }

  setState(state, extra = {}) {
    this.state = state
    this.emit('status', { provider: this.providerName, state, ...extra, timestamp: new Date().toISOString() })
  }

  getStatus() {
    return { provider: this.providerName, state: this.state, ready: this.state === 'ready' }
  }

  async start() { throw new Error('Not implemented') }
  async stop() {}
  async resolveRecipient() { throw new Error('Not implemented') }
  async resolveContactInfo() { return null }

  async listUnreadChats() { return [] }
  async sendText() { throw new Error('Not implemented') }
  async markRead() { return 0 }
}

