import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

let failed = false
try {
  const wweb = require('whatsapp-web.js')
  if (!wweb.Client || !wweb.LocalAuth) throw new Error('Client/LocalAuth exports missing')
  console.log('whatsapp-web.js import contract: PASS')
} catch (error) {
  failed = true
  console.error('whatsapp-web.js import contract: FAIL', error.message)
}

try {
  const b = await import('@whiskeysockets/baileys')
  if (!b.default || !b.useMultiFileAuthState || !b.DisconnectReason) throw new Error('Expected Baileys exports missing')
  console.log('Baileys import contract: PASS')
} catch (error) {
  failed = true
  console.error('Baileys import contract: FAIL', error.message)
}

try {
  require('qrcode-terminal')
  console.log('qrcode-terminal import contract: PASS')
} catch (error) {
  failed = true
  console.error('qrcode-terminal import contract: FAIL', error.message)
}

process.exit(failed ? 1 : 0)
