import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ChatRailApiClient } from './api-client.js'
import { AppError } from './errors.js'

export const MCP_SERVER_NAME = 'chatrail'
export const MCP_SERVER_VERSION = '1.0.0'

function jsonText(value) {
  return JSON.stringify(value, null, 2)
}

function toolSuccess(value) {
  return {
    content: [{ type: 'text', text: jsonText(value) }]
  }
}

function toolFailure(error) {
  const body = error instanceof AppError
    ? {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details })
        }
      }
    : {
        ok: false,
        error: {
          code: 'MCP_INTERNAL_ERROR',
          message: String(error?.message || error)
        }
      }

  return {
    isError: true,
    content: [{ type: 'text', text: jsonText(body) }]
  }
}

function wrap(handler) {
  return async args => {
    try {
      return toolSuccess(await handler(args || {}))
    } catch (error) {
      return toolFailure(error)
    }
  }
}

function resourceJson(uri, value) {
  return {
    contents: [{
      uri,
      mimeType: 'application/json',
      text: jsonText(value)
    }]
  }
}

const phoneSchema = z.string()
  .min(8)
  .max(30)
  .describe('Phone number. Brazilian local formats are normalized by the ChatRail API.')

const limitSchema = z.number().int().min(1).max(1000).default(100)

export function createChatRailMcpServer({
  apiClient = new ChatRailApiClient(),
  serverName = MCP_SERVER_NAME,
  serverVersion = MCP_SERVER_VERSION
} = {}) {
  const server = new McpServer({
    name: serverName,
    version: serverVersion
  }, {
    capabilities: {
      logging: {}
    },
    instructions: [
      'Use ChatRail tools instead of WhatsApp UI automation.',
      'Register a recipient before sending unless the gateway is explicitly configured otherwise.',
      'Prefer list_replies for actionable inbound replies; list_messages is technical history.',
      'Never interpret numeric @lid identifiers as phone numbers.',
      'Treat duplicate=true as an idempotent success and do not resend automatically.',
      'Do not send bulk or unsolicited messages.'
    ].join(' ')
  })

  server.registerTool('get_status', {
    title: 'ChatRail status',
    description: 'Return daemon version, provider connection state, safeguards and message counters.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  }, wrap(() => apiClient.status()))

  server.registerTool('get_health', {
    title: 'ChatRail health',
    description: 'Return lightweight API/provider health information.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  }, wrap(() => apiClient.health()))

  server.registerTool('list_recipients', {
    title: 'List recipients',
    description: 'List the local recipient allowlist.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  }, wrap(() => apiClient.listRecipients()))

  server.registerTool('register_recipient', {
    title: 'Register recipient',
    description: 'Create or update a recipient in the outbound allowlist. UTF-8 safety rules remain enforced by the API.',
    inputSchema: {
      phone: phoneSchema,
      name: z.string().max(200).default(''),
      source: z.string().max(500).default(''),
      tags: z.array(z.string().max(100)).max(50).default([]),
      notes: z.string().max(5000).default('')
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  }, wrap(args => apiClient.registerRecipient(args)))

  server.registerTool('send_message', {
    title: 'Send WhatsApp message',
    description: 'Send one text message through the ChatRail daemon. Recipient allowlist, WhatsApp registration checks, dedupe and idempotency are enforced.',
    inputSchema: {
      phone: phoneSchema,
      text: z.string().min(1).max(10000),
      idempotencyKey: z.string().max(500).optional(),
      dryRun: z.boolean().default(false),
      force: z.boolean().default(false)
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    }
  }, wrap(args => apiClient.sendMessage(args)))

  server.registerTool('list_sends', {
    title: 'List send attempts',
    description: 'Read persisted dry-run, sent, submitted-unconfirmed and failed send records.',
    inputSchema: {
      phone: phoneSchema.optional(),
      limit: limitSchema
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  }, wrap(args => apiClient.listSends(args)))

  server.registerTool('list_messages', {
    title: 'List observed messages',
    description: 'Read persisted technical message history. Use list_replies for actionable replies.',
    inputSchema: {
      phone: phoneSchema.optional(),
      direction: z.enum(['in', 'out']).optional(),
      unreadOnly: z.boolean().default(false),
      limit: limitSchema
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  }, wrap(args => apiClient.listMessages(args)))

  server.registerTool('list_replies', {
    title: 'List recipient replies',
    description: 'Return reply-eligible inbound messages observed after the first outbound send. Defaults to unread only.',
    inputSchema: {
      unreadOnly: z.boolean().default(true),
      limit: limitSchema
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  }, wrap(args => apiClient.listReplies(args)))

  server.registerTool('get_reply_state', {
    title: 'Get recipient reply state',
    description: 'Return reply watch epoch, bound JIDs and reply counts for one recipient.',
    inputSchema: {
      phone: phoneSchema
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  }, wrap(({ phone }) => apiClient.replyState(phone)))

  server.registerTool('list_chats', {
    title: 'List observed chats',
    description: 'Return local summaries of conversations observed by the daemon.',
    inputSchema: {
      limit: limitSchema
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  }, wrap(args => apiClient.listChats(args)))

  server.registerTool('list_unread_chats', {
    title: 'List real WhatsApp unread chats',
    description: 'Read authoritative WhatsApp unread counters plus a best-effort snapshot of recent inbound messages for those chats, without marking anything as read.',
    inputSchema: {
      includeMessages: z.boolean().default(true),
      maxMessagesPerChat: z.number().int().min(1).max(2000).default(500)
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  }, wrap(args => apiClient.listUnreadChats(args)))

  server.registerTool('mark_read', {
    title: 'Mark recipient replies read',
    description: 'Mark eligible inbound replies for one recipient as read locally and, when supported, send seen to WhatsApp.',
    inputSchema: {
      phone: phoneSchema
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    }
  }, wrap(({ phone }) => apiClient.markRead(phone)))

  server.registerTool('list_events', {
    title: 'List diagnostic events',
    description: 'Read provider, identity, send, receive and acknowledgement events.',
    inputSchema: {
      since: z.string().datetime({ offset: true }).optional(),
      limit: z.number().int().min(1).max(1000).default(200)
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  }, wrap(args => apiClient.listEvents(args)))

  server.registerTool('list_unresolved', {
    title: 'List unresolved identities',
    description: 'Read actionable inbound/outbound messages whose WhatsApp identity could not be mapped safely to a phone.',
    inputSchema: {
      limit: limitSchema
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  }, wrap(args => apiClient.listUnresolved(args)))

  server.registerResource('status', 'chatrail://status', {
    title: 'ChatRail WhatsApp status',
    description: 'Current provider and safeguard status',
    mimeType: 'application/json'
  }, async uri => resourceJson(uri.href, await apiClient.status()))

  server.registerResource('recipients', 'chatrail://recipients', {
    title: 'ChatRail recipients',
    description: 'Current local recipient allowlist',
    mimeType: 'application/json'
  }, async uri => resourceJson(uri.href, await apiClient.listRecipients()))

  server.registerResource('replies', 'chatrail://replies', {
    title: 'ChatRail unread replies',
    description: 'Current unread reply-eligible messages',
    mimeType: 'application/json'
  }, async uri => resourceJson(uri.href, await apiClient.listReplies({ unreadOnly: true, limit: 100 })))

  server.registerResource('unresolved', 'chatrail://unresolved', {
    title: 'ChatRail unresolved identities',
    description: 'Messages whose WhatsApp identity could not be resolved safely',
    mimeType: 'application/json'
  }, async uri => resourceJson(uri.href, await apiClient.listUnresolved({ limit: 100 })))

  server.registerResource(
    'recipient-reply-state',
    new ResourceTemplate('chatrail://recipient/{phone}/reply-state', { list: undefined }),
    {
      title: 'Recipient reply state',
      description: 'Reply watch state for one recipient',
      mimeType: 'application/json'
    },
    async (uri, variables) => {
      const phone = String(variables.phone || '')
      return resourceJson(uri.href, await apiClient.replyState(phone))
    }
  )

  server.registerPrompt('triage_whatsapp_replies', {
    title: 'Triage WhatsApp replies',
    description: 'Instructions for reviewing unread recipient replies safely before any new outreach.',
    argsSchema: {
      objective: z.string().max(1000).optional()
    }
  }, async ({ objective }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: [
          'Review WhatsApp recipient replies using the ChatRail MCP tools.',
          'Start with list_replies(unreadOnly=true).',
          'For any ambiguous identity, inspect get_reply_state and list_unresolved.',
          'Do not infer a phone number from an @lid identifier.',
          'Do not send a message unless the user explicitly requested the send.',
          objective ? `Objective: ${objective}` : ''
        ].filter(Boolean).join('\n')
      }
    }]
  }))

  server.registerPrompt('prepare_safe_whatsapp_send', {
    title: 'Prepare safe WhatsApp send',
    description: 'Instructions for preparing a single allowlisted WhatsApp send with idempotency and dry-run first.',
    argsSchema: {
      phone: phoneSchema,
      purpose: z.string().min(1).max(1000)
    }
  }, async ({ phone, purpose }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: [
          `Prepare a single WhatsApp message for ${phone}.`,
          `Purpose: ${purpose}`,
          'Check list_recipients first.',
          'Use send_message with dryRun=true before any real send.',
          'Use a stable idempotencyKey.',
          'Do not use force unless the user explicitly requests an intentional resend.',
          'Do not bypass recipient allowlist safeguards.'
        ].join('\n')
      }
    }]
  }))

  return server
}

