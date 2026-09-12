#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, parseCliArgs, resolveRuntimeHome } from './config.js'
import { createApp } from './app.js'
import { resolveProviderName } from './provider-factory.js'
import { SERVICE_VERSION } from './service.js'
import { runDoctor } from './doctor.js'

const thisFile = fileURLToPath(import.meta.url)
const packageRoot = path.dirname(path.dirname(thisFile))

function usage() {
  console.log(`ChatRail v${SERVICE_VERSION}

Usage:
  chatrail init
  chatrail start [--provider=auto|wwebjs|baileys|fake] [--host=...] [--port=...]
  chatrail status
  chatrail doctor
  chatrail home
  chatrail help

Environment:
  CHATRAIL_HOME   Override the runtime directory (default: ~/.chatrail)
`)
}

function runtimeHome() {
  return resolveRuntimeHome()
}

async function init() {
  const home = process.env.CHATRAIL_HOME
    ? path.resolve(process.env.CHATRAIL_HOME)
    : path.join((await import('node:os')).homedir(), '.chatrail')

  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(path.join(home, 'data'), { recursive: true })
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true })

  const target = path.join(home, '.env')
  if (!fs.existsSync(target)) {
    const template = path.join(packageRoot, '.env.example')
    if (!fs.existsSync(template)) {
      throw new Error(`Missing configuration template: ${template}`)
    }
    fs.copyFileSync(template, target)
    console.log(`Created ${target}`)
  } else {
    console.log(`Configuration already exists: ${target}`)
  }

  console.log(`ChatRail home: ${home}`)
  console.log(`Next: chatrail start`)
}

async function start(args) {
  const overrides = parseCliArgs(args)
  const config = loadConfig({ overrides })
  const selected = resolveProviderName(config)

  console.log(`ChatRail v${SERVICE_VERSION}`)
  console.log(`Home: ${config.runtimeHome}`)
  console.log(`Provider: ${selected}`)
  console.log(`Data: ${config.dataDir}`)
  console.log(`API: http://${config.host}:${config.port}`)
  console.log(`Recipient allowlist: ${config.allowUnregistered ? 'OFF' : 'ON'}`)

  if (selected === 'baileys') {
    console.log('Note: current upstream Baileys has reported fresh-pairing regressions; auto mode uses it only when an existing Baileys auth session is present.')
  }

  const app = await createApp(config)

  const shutdown = async signal => {
    console.log(`\n${signal}: stopping...`)
    try { await app.stop() } finally { process.exit(0) }
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  await app.start()
  console.log('HTTP API listening. Use `chatrail status` for connection state.')
}

async function status() {
  const config = loadConfig()
  const headers = { accept: 'application/json' }
  if (config.apiToken) headers.authorization = `Bearer ${config.apiToken}`

  const response = await fetch(`http://${config.host}:${config.port}/status`, { headers })
  const text = await response.text()

  if (!response.ok) {
    throw new Error(`ChatRail API returned HTTP ${response.status}: ${text}`)
  }

  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2))
  } catch {
    console.log(text)
  }
}

const argv = process.argv.slice(2)
const first = argv[0]
const command = !first || first.startsWith('--') ? 'start' : first
const commandArgs = command === 'start' && first?.startsWith('--') ? argv : argv.slice(1)

try {
  if (command === 'init') {
    await init()
  } else if (command === 'start') {
    await start(commandArgs)
  } else if (command === 'status') {
    await status()
  } else if (command === 'doctor') {
    const ok = await runDoctor()
    process.exitCode = ok ? 0 : 1
  } else if (command === 'home') {
    console.log(runtimeHome())
  } else if (command === 'help' || command === '--help' || command === '-h') {
    usage()
  } else {
    console.error(`Unknown command: ${command}`)
    usage()
    process.exitCode = 1
  }
} catch (error) {
  console.error(error?.stack || error)
  process.exitCode = 1
}
