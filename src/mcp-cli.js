#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ChatRailApiClient } from './api-client.js'
import { loadEnvFile } from './config.js'
import { createChatRailMcpServer } from './mcp/server.js'

const fileEnv = loadEnvFile(process.cwd())

const baseUrl =
  process.env.MCP_API_BASE_URL ||
  fileEnv.MCP_API_BASE_URL ||
  process.env.CHATRAIL_API_BASE_URL ||
  fileEnv.CHATRAIL_API_BASE_URL ||
  `http://${fileEnv.HOST || '127.0.0.1'}:${fileEnv.PORT || '3333'}`

const token = process.env.API_TOKEN || fileEnv.API_TOKEN || ''
const timeoutMs = Number(
  process.env.MCP_API_TIMEOUT_MS ||
  fileEnv.MCP_API_TIMEOUT_MS ||
  15000
)

const apiClient = new ChatRailApiClient({
  baseUrl,
  token,
  timeoutMs
})

const server = createChatRailMcpServer({ apiClient })
const transport = new StdioServerTransport()

try {
  await server.connect(transport)
  console.error(`[chatrail-mcp] connected over stdio; API=${apiClient.baseUrl}`)
} catch (error) {
  console.error(`[chatrail-mcp] fatal: ${error?.stack || error}`)
  process.exit(1)
}