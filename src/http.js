import http from 'node:http'
import { URL } from 'node:url'
import { AppError, toErrorBody } from './errors.js'
import { normalizePhone } from './normalize.js'

const MAX_BODY = 1024 * 1024

function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body, null, 2))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store'
  })
  res.end(payload)
}

async function readJson(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new AppError('Request body too large', { status: 413, code: 'BODY_TOO_LARGE' })
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  const raw = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(raw)
  } catch {
    throw new AppError('Malformed JSON body', { code: 'MALFORMED_JSON' })
  }
}

function authorized(req, config) {
  if (!config.apiToken) return true
  return req.headers.authorization === `Bearer ${config.apiToken}`
}

export function createHttpServer({ service, store, provider, config, logger }) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true, provider: provider.getStatus(), time: new Date().toISOString() })
    }

    if (!authorized(req, config)) {
      return sendJson(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid or missing bearer token' } })
    }

    try {
      if (req.method === 'GET' && url.pathname === '/') {
        return sendJson(res, 200, {
          ok: true,
          service: 'chatrail',
          endpoints: ['/health', '/status', '/recipients', '/send', '/sends', '/messages', '/replies', '/chats', '/unread', '/mark-read', '/events', '/unresolved', '/reply-state']
        })
      }

      if (req.method === 'GET' && url.pathname === '/status') {
        return sendJson(res, 200, { ok: true, ...service.status() })
      }

      if (req.method === 'GET' && url.pathname === '/recipients') {
        return sendJson(res, 200, { ok: true, recipients: store.listRecipients() })
      }

      if (req.method === 'POST' && url.pathname === '/recipients') {
        const body = await readJson(req)
        const recipient = await service.registerRecipient(body)
        return sendJson(res, 201, { ok: true, recipient })
      }

      if (req.method === 'POST' && url.pathname === '/send') {
        const body = await readJson(req)
        const result = await service.send(body)
        return sendJson(res, result.duplicate ? 200 : 201, result)
      }

      if (req.method === 'GET' && url.pathname === '/sends') {
        const phoneRaw = url.searchParams.get('phone')
        const phone = phoneRaw ? normalizePhone(phoneRaw, config.defaultCountryCode) : undefined
        const sends = store.listSends({
          phone,
          limit: url.searchParams.get('limit') || 100
        })
        return sendJson(res, 200, { ok: true, sends })
      }

      if (req.method === 'GET' && url.pathname === '/messages') {
        const phoneRaw = url.searchParams.get('phone')
        const phone = phoneRaw ? normalizePhone(phoneRaw, config.defaultCountryCode) : undefined
        const messages = store.listMessages({
          phone,
          direction: url.searchParams.get('direction') || undefined,
          unreadOnly: url.searchParams.get('unreadOnly') === '1',
          limit: url.searchParams.get('limit') || 100
        })
        return sendJson(res, 200, { ok: true, messages })
      }

      if (req.method === 'GET' && url.pathname === '/replies') {
        const replies = store.listReplies({
          unreadOnly: url.searchParams.get('unreadOnly') !== '0',
          limit: url.searchParams.get('limit') || 100
        })
        return sendJson(res, 200, { ok: true, replies })
      }

      if (req.method === 'GET' && url.pathname === '/reply-state') {
        const phoneRaw = url.searchParams.get('phone')
        if (!phoneRaw) throw new AppError('phone query parameter is required', { status: 400, code: 'PHONE_REQUIRED' })
        const phone = normalizePhone(phoneRaw, config.defaultCountryCode)
        const state = store.replyState(phone)
        if (!state) throw new AppError('Recipient not found', { status: 404, code: 'RECIPIENT_NOT_FOUND' })
        return sendJson(res, 200, { ok: true, ...state })
      }

      if (req.method === 'GET' && url.pathname === '/chats') {
        return sendJson(res, 200, { ok: true, chats: store.listChats({ limit: url.searchParams.get('limit') || 100 }) })
      }

      if (req.method === 'GET' && url.pathname === '/unread') {
        const includeMessages = url.searchParams.get('includeMessages') !== '0'
        const maxMessagesPerChat = Number(url.searchParams.get('maxMessagesPerChat') || 500)
        const result = await service.listUnreadChats({ includeMessages, maxMessagesPerChat })
        return sendJson(res, 200, { ok: true, ...result })
      }

      if (req.method === 'POST' && url.pathname === '/mark-read') {
        const body = await readJson(req)
        const result = await service.markRead(body.phone)
        return sendJson(res, 200, { ok: true, ...result })
      }

      if (req.method === 'GET' && url.pathname === '/unresolved') {
        const messages = store.listUnresolvedMessages({ limit: url.searchParams.get('limit') || 100 })
        return sendJson(res, 200, { ok: true, messages })
      }

      if (req.method === 'GET' && url.pathname === '/events') {
        const events = store.listEvents({ since: url.searchParams.get('since'), limit: url.searchParams.get('limit') || 200 })
        return sendJson(res, 200, { ok: true, events })
      }

      if (req.method === 'POST' && url.pathname === '/debug/inbound') {
        if (provider.providerName !== 'fake' || typeof provider.simulateInbound !== 'function') {
          throw new AppError('Debug inbound endpoint is available only with fake provider', { status: 404, code: 'NOT_FOUND' })
        }
        const body = await readJson(req)
        const phone = normalizePhone(body.phone, config.defaultCountryCode)
        await provider.simulateInbound(phone, String(body.text || ''))
        return sendJson(res, 201, { ok: true })
      }

      throw new AppError('Not found', { status: 404, code: 'NOT_FOUND' })
    } catch (error) {
      if (!(error instanceof AppError)) logger?.error('Unhandled HTTP error', error)
      return sendJson(res, error.status || 500, toErrorBody(error))
    }
  })
}
