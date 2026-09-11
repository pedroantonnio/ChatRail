import fs from 'node:fs'
import path from 'node:path'
import { JsonStore } from './store.js'
import { createLogger } from './logger.js'
import { createProvider } from './provider-factory.js'
import { WhatsAppService } from './service.js'
import { createHttpServer } from './http.js'
import { assertSafeConfig } from './config.js'

export async function createApp(config, { provider: injectedProvider, logger: injectedLogger } = {}) {
  assertSafeConfig(config)
  await fs.promises.mkdir(config.dataDir, { recursive: true })
  const logger = injectedLogger || createLogger(config.logLevel)
  const statePath = path.join(config.dataDir, 'chatrail-state.json')
  const legacyStatePath = path.join(config.dataDir, 'agent-state.json')
  if (!fs.existsSync(statePath) && fs.existsSync(legacyStatePath)) {
    await fs.promises.rename(legacyStatePath, statePath)
  }
  const store = new JsonStore(statePath)
  await store.load()
  const provider = injectedProvider || createProvider(config, logger)
  const service = new WhatsAppService({ config, store, provider, logger })
  const server = createHttpServer({ service, store, provider, config, logger })

  return {
    config,
    logger,
    store,
    provider,
    service,
    server,
    async start({ startProvider = true, waitForProvider = false } = {}) {
      await new Promise((resolve, reject) => {
        const onError = error => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.off('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(config.port, config.host)
      })
      if (startProvider) {
        const providerStart = provider.start().catch(error => {
          logger.error('Provider start failed', error)
          provider.setState?.('error', { message: String(error.message || error) })
          if (waitForProvider) throw error
        })
        if (waitForProvider) await providerStart
      }
      return server.address()
    },
    async stop() {
      await new Promise(resolve => server.listening ? server.close(() => resolve()) : resolve())
      await provider.stop()
    }
  }
}
