import test from 'node:test'
import assert from 'node:assert/strict'
import { ChatRailApiClient } from '../packages/chatrail-mcp/src/api-client.js'
import { createChatRailMcpServer } from '../packages/chatrail-mcp/src/server.js'

test('standalone MCP package exports a working API client and server factory', async () => {
  const client = new ChatRailApiClient({
    baseUrl: 'http://127.0.0.1:3333',
    fetchImpl: async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  })

  assert.equal(client.baseUrl, 'http://127.0.0.1:3333')

  const server = createChatRailMcpServer({ apiClient: client })
  assert.ok(server)
  await server.close()
})