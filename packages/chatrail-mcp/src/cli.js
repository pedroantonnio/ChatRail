#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ChatRailApiClient } from './api-client.js'
import { createChatRailMcpServer } from './server.js'

function parseEnvFile(text) {
  const result = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const idx = line.indexOf('=')
    if (idx < 0) continue
    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    result[key] = value
  }
  return result
}

function loadEnvFile(dir) {
  const file = path.join(dir, '.env')
  if (!fs.existsSync(file)) return {}
  return parseEnvFile(fs.readFileSync(file, 'utf8'))
}

const runtimeHome = process.env.CHATRAIL_HOME
  ? path.resolve(process.env.CHATRAIL_HOME)
  : path.join(os.homedir(), '.chatrail')

const fileEnv = loadEnvFile(runtimeHome)
const host = fileEnv.HOST || '127.0.0.1'
const port = fileEnv.PORT || '3333'

const baseUrl =
  process.env.MCP_API_BASE_URL ||
  fileEnv.MCP_API_BASE_URL ||
  process.env.CHATRAIL_API_BASE_URL ||
  fileEnv.CHATRAIL_API_BASE_URL ||
  'http://' + host + ':' + port

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
  console.error('[chatrail-mcp] connected over stdio; API=' + apiClient.baseUrl)
} catch (error) {
  console.error('[chatrail-mcp] fatal: ' + (error?.stack || error))
  process.exit(1)
}