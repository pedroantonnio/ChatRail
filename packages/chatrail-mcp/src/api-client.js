import { AppError } from './errors.js'

function normalizeBaseUrl(value) {
  return String(value || 'http://127.0.0.1:3333').replace(/\/+$/, '')
}

export class ChatRailApiClient {
  constructor({
    baseUrl = process.env.MCP_API_BASE_URL || process.env.CHATRAIL_API_BASE_URL || 'http://127.0.0.1:3333',
    token = process.env.API_TOKEN || '',
    timeoutMs = Number(process.env.MCP_API_TIMEOUT_MS || 15000),
    fetchImpl = globalThis.fetch
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required')
    this.baseUrl = normalizeBaseUrl(baseUrl)
    this.token = String(token || '')
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000
    this.fetchImpl = fetchImpl
  }

  async request(method, pathname, { query, body } = {}) {
    const url = new URL(pathname, `${this.baseUrl}/`)
    for (const [key, value] of Object.entries(query || {})) {
      if (value === undefined || value === null || value === '') continue
      url.searchParams.set(key, String(value))
    }

    const headers = {
      accept: 'application/json'
    }
    if (this.token) headers.authorization = `Bearer ${this.token}`

    let payload
    if (body !== undefined) {
      headers['content-type'] = 'application/json; charset=utf-8'
      payload = JSON.stringify(body)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    let response
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: payload,
        signal: controller.signal
      })
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new AppError(`ChatRail API timed out after ${this.timeoutMs}ms`, {
          status: 504,
          code: 'API_TIMEOUT'
        })
      }
      throw new AppError(`Cannot reach ChatRail API at ${this.baseUrl}: ${error?.message || error}`, {
        status: 503,
        code: 'API_UNREACHABLE'
      })
    } finally {
      clearTimeout(timer)
    }

    let data
    try {
      data = await response.json()
    } catch {
      throw new AppError(`ChatRail API returned non-JSON response (${response.status})`, {
        status: 502,
        code: 'API_INVALID_RESPONSE'
      })
    }

    if (!response.ok) {
      const remote = data?.error || {}
      throw new AppError(remote.message || `ChatRail API returned HTTP ${response.status}`, {
        status: response.status,
        code: remote.code || 'API_ERROR',
        details: remote.details
      })
    }

    return data
  }

  health() {
    return this.request('GET', '/health')
  }

  status() {
    return this.request('GET', '/status')
  }

  listRecipients() {
    return this.request('GET', '/recipients')
  }

  registerRecipient(input) {
    return this.request('POST', '/recipients', { body: input })
  }

  sendMessage(input) {
    return this.request('POST', '/send', { body: input })
  }

  listSends({ phone, limit = 100 } = {}) {
    return this.request('GET', '/sends', {
      query: {
        phone,
        limit
      }
    })
  }

  listMessages({ phone, direction, unreadOnly = false, limit = 100 } = {}) {
    return this.request('GET', '/messages', {
      query: {
        phone,
        direction,
        unreadOnly: unreadOnly ? 1 : undefined,
        limit
      }
    })
  }

  listReplies({ unreadOnly = true, limit = 100 } = {}) {
    return this.request('GET', '/replies', {
      query: {
        unreadOnly: unreadOnly ? 1 : 0,
        limit
      }
    })
  }

  replyState(phone) {
    return this.request('GET', '/reply-state', { query: { phone } })
  }

  listChats({ limit = 100 } = {}) {
    return this.request('GET', '/chats', { query: { limit } })
  }

  listUnreadChats({ includeMessages = true, maxMessagesPerChat = 500 } = {}) {
    return this.request('GET', '/unread', {
      query: {
        includeMessages: includeMessages ? 1 : 0,
        maxMessagesPerChat
      }
    })
  }

  markRead(phone) {
    return this.request('POST', '/mark-read', { body: { phone } })
  }

  listEvents({ since, limit = 200 } = {}) {
    return this.request('GET', '/events', { query: { since, limit } })
  }

  listUnresolved({ limit = 100 } = {}) {
    return this.request('GET', '/unresolved', { query: { limit } })
  }
}