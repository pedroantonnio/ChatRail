import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizePhone, phoneFromJid, parseBoolean, jidKind, hasUnicodeReplacement } from '../src/normalize.js'

 test('normalizes a local mobile number with an explicit default country code', () => {
  assert.equal(normalizePhone('7700 900123', '44'), '447700900123')
})

test('preserves an already international number', () => {
  assert.equal(normalizePhone('+44 7700 900123', '44'), '447700900123')
})

test('rejects clearly invalid phone', () => {
  assert.throws(() => normalizePhone('123', '44'), /10 to 15 digits/)
})

test('extracts phone from WhatsApp style JIDs', () => {
  assert.equal(phoneFromJid('447700900123@c.us'), '447700900123')
  assert.equal(phoneFromJid('447700900123:7@s.whatsapp.net'), '447700900123')
  assert.equal(phoneFromJid('130786200146109@lid'), null)
  assert.equal(jidKind('130786200146109@lid'), 'lid')
})


test('boolean parser is conservative', () => {
  assert.equal(parseBoolean('true', false), true)
  assert.equal(parseBoolean('0', true), false)
  assert.equal(parseBoolean('nonsense', false), false)
})


test('detects Unicode replacement character so safety decisions cannot be bypassed by broken encoding', () => {
  assert.equal(hasUnicodeReplacement('valid text'), false)
  assert.equal(hasUnicodeReplacement('broken�text'), true)
  assert.equal(hasUnicodeReplacement('�'), true)
})
