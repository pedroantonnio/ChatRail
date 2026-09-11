import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createApp } from '../src/app.js'
import { ChatRailApiClient } from '../src/api-client.js'
import { createChatRailMcpServer } from '../src/mcp/server.js'
import { FakeProvider } from '../src/providers/fake.js'
import { createLogger } from '../src/logger.js'

async function fixture() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wa-mcp-'))
  const config = {
    host: '127.0.0.1',
    port: 0,
    provider: 'fake',
    dataDir: dir,
    defaultCountryCode: '44',
    allowUnregistered: false,
    allowGroups: false,

    dedupeWindowHours: 720,
    apiToken: '',
    headless: true,
    logLevel: 'silent'
  }

  const provider = new FakeProvider({ logger: createLogger('silent') })
  const app = await createApp(config, { provider, logger: createLogger('silent') })
  const addr = await app.start({ waitForProvider: true })
  const apiClient = new ChatRailApiClient({ baseUrl: `http://127.0.0.1:${addr.port}` })
  const server = createChatRailMcpServer({ apiClient })
  const client = new Client({ name: 'chatrail-mcp-test-client', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

  await server.connect(serverTransport)
  await client.connect(clientTransport)

  return { dir, app, provider, server, client }
}

async function cleanup(f) {
  await f.client.close()
  await f.server.close()
  await f.app.stop()
  fs.rmSync(f.dir, { recursive: true, force: true })
}

function parseTool(result) {
  const text = result.content.find(item => item.type === 'text')?.text
  return text ? JSON.parse(text) : null
}

test('MCP exposes complete WhatsApp tool surface, resources and prompts', async t => {
  const f = await fixture()
  t.after(() => cleanup(f))

  const tools = await f.client.listTools()
  const names = new Set(tools.tools.map(tool => tool.name))
  for (const expected of [
    'get_status',
    'get_health',
    'list_recipients',
    'register_recipient',
    'send_message',
    'list_sends',
    'list_messages',
    'list_replies',
    'get_reply_state',
    'list_chats',
    'mark_read',
    'list_events',
    'list_unresolved'
  ]) {
    assert.ok(names.has(expected), `missing MCP tool ${expected}`)
  }

  const resources = await f.client.listResources()
  const uris = new Set(resources.resources.map(resource => resource.uri))
  assert.ok(uris.has('chatrail://status'))
  assert.ok(uris.has('chatrail://recipients'))
  assert.ok(uris.has('chatrail://replies'))
  assert.ok(uris.has('chatrail://unresolved'))

  const prompts = await f.client.listPrompts()
  const promptNames = new Set(prompts.prompts.map(prompt => prompt.name))
  assert.ok(promptNames.has('triage_whatsapp_replies'))
  assert.ok(promptNames.has('prepare_safe_whatsapp_send'))
})

test('MCP end-to-end register, dry-run, real send, inbound reply and mark-read', async t => {
  const f = await fixture()
  t.after(() => cleanup(f))

  let result = await f.client.callTool({
    name: 'register_recipient',
    arguments: {
      phone: '7700900123',
      name: 'Test MCP',
      source: 'offline-test'
    }
  })
  assert.equal(result.isError, undefined)
  let body = parseTool(result)
  assert.equal(body.recipient.phone, '447700900123')

  result = await f.client.callTool({
    name: 'send_message',
    arguments: {
      phone: '7700900123',
      text: 'MCP dry run',
      idempotencyKey: 'mcp-dry-1',
      dryRun: true
    }
  })
  body = parseTool(result)
  assert.equal(body.dryRun, true)
  assert.equal(f.provider.sent.length, 0)

  result = await f.client.callTool({
    name: 'send_message',
    arguments: {
      phone: '7700900123',
      text: 'MCP real fake-provider send',
      idempotencyKey: 'mcp-real-1'
    }
  })
  body = parseTool(result)
  assert.equal(body.send.status, 'sent')
  assert.equal(f.provider.sent.length, 1)

  await f.provider.simulateInbound('447700900123', 'MCP test reply')
  await new Promise(resolve => setTimeout(resolve, 30))

  result = await f.client.callTool({
    name: 'list_replies',
    arguments: { unreadOnly: true, limit: 20 }
  })
  body = parseTool(result)
  assert.deepEqual(body.replies.map(row => row.text), ['MCP test reply'])

  result = await f.client.callTool({
    name: 'get_reply_state',
    arguments: { phone: '7700900123' }
  })
  body = parseTool(result)
  assert.equal(body.eligibleReplyCount, 1)
  assert.equal(body.unreadReplyCount, 1)

  result = await f.client.callTool({
    name: 'mark_read',
    arguments: { phone: '7700900123' }
  })
  body = parseTool(result)
  assert.equal(body.localCount, 1)
})

test('MCP preserves API safety errors as tool errors', async t => {
  const f = await fixture()
  t.after(() => cleanup(f))

  const result = await f.client.callTool({
    name: 'send_message',
    arguments: {
      phone: '7700900123',
      text: 'Should not send',
      idempotencyKey: 'blocked-unregistered'
    }
  })

  assert.equal(result.isError, true)
  const body = parseTool(result)
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'UNREGISTERED_RECIPIENT')
  assert.equal(f.provider.sent.length, 0)
})

test('MCP resources read live daemon state', async t => {
  const f = await fixture()
  t.after(() => cleanup(f))

  const status = await f.client.readResource({ uri: 'chatrail://status' })
  const body = JSON.parse(status.contents[0].text)
  assert.equal(body.ok, true)
  assert.equal(body.provider.ready, true)

  await f.client.callTool({
    name: 'register_recipient',
    arguments: {
      phone: '7700900123',
      name: 'Resource Recipient'
    }
  })

  const recipients = await f.client.readResource({ uri: 'chatrail://recipients' })
  const recipientsBody = JSON.parse(recipients.contents[0].text)
  assert.equal(recipientsBody.recipients.length, 1)
})

test('MCP prompt instructs dry-run and safe reply triage', async t => {
  const f = await fixture()
  t.after(() => cleanup(f))

  const sendPrompt = await f.client.getPrompt({
    name: 'prepare_safe_whatsapp_send',
    arguments: {
      phone: '7700900123',
      purpose: 'teste'
    }
  })
  assert.match(sendPrompt.messages[0].content.text, /dryRun=true/)
  assert.match(sendPrompt.messages[0].content.text, /idempotencyKey/)

  const triagePrompt = await f.client.getPrompt({
    name: 'triage_whatsapp_replies',
    arguments: {}
  })
  assert.match(triagePrompt.messages[0].content.text, /list_replies/)
  assert.match(triagePrompt.messages[0].content.text, /@lid/)
})
