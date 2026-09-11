import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import assert from 'node:assert/strict'
import { JsonStore } from '../src/store.js'
import { WhatsAppService } from '../src/service.js'
import { FakeProvider } from '../src/providers/fake.js'
import { createLogger } from '../src/logger.js'

const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chatrail-stress-'))
const logger = createLogger('silent')
const store = new JsonStore(path.join(dir, 'state.json'))
await store.load()
const provider = new FakeProvider({ logger })
provider.sendDelayMs = 5
await provider.start()
const config = {
  defaultCountryCode: '44',
  allowUnregistered: false,
  allowGroups: false,

  dedupeWindowHours: 720
}
const service = new WhatsAppService({ config, store, provider, logger })

try {
  await service.registerRecipient({ phone: '7700900123', name: 'Stress Recipient' })

  const batch = await Promise.all(Array.from({ length: 100 }, () =>
    service.send({ phone: '7700900123', text: 'same payload' })
  ))
  assert.equal(provider.sent.length, 1)
  assert.equal(batch.filter(x => x.duplicate === false).length, 1)
  assert.equal(batch.filter(x => x.duplicate === true).length, 99)

  for (let i = 0; i < 50; i++) {
    await provider.simulateInbound('447700900123', `reply-${i}`)
  }
  await new Promise(resolve => setTimeout(resolve, 750))
  assert.equal(store.listReplies({ unreadOnly: true, limit: 1000 }).length, 50)

  const reload = new JsonStore(path.join(dir, 'state.json'))
  await reload.load()
  assert.equal(reload.listReplies({ unreadOnly: true, limit: 1000 }).length, 50)
  assert.equal(reload.snapshot().sends.filter(s => s.status === 'sent').length, 1)

  console.log('STRESS PASS')
  console.log(JSON.stringify({
    concurrentIdenticalSendRequests: 100,
    actualProviderSends: provider.sent.length,
    suppressedDuplicates: 99,
    inboundEvents: 50,
    persistedInboundRepliesAfterReload: 50
  }, null, 2))
} finally {
  await provider.stop()
  fs.rmSync(dir, { recursive: true, force: true })
}
