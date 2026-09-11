import { AppError } from './errors.js'

export function hasUnicodeReplacement(input = '') {
  return String(input).includes('\uFFFD')
}

export function normalizePhone(input, defaultCountryCode = '55') {
  if (input === null || input === undefined) {
    throw new AppError('phone is required', { code: 'PHONE_REQUIRED' })
  }

  let digits = String(input).replace(/\D/g, '')
  if (!digits) {
    throw new AppError('phone contains no digits', { code: 'PHONE_INVALID' })
  }

  const cc = String(defaultCountryCode || '').replace(/\D/g, '')
  if (digits.length >= 10 && digits.length <= 11 && cc) {
    digits = cc + digits
  }

  if (digits.length < 10 || digits.length > 15) {
    throw new AppError('phone must contain 10 to 15 digits after normalization', {
      code: 'PHONE_INVALID',
      details: { normalized: digits }
    })
  }

  return digits
}

export function jidKind(jid) {
  const raw = String(jid || '').toLowerCase()
  if (raw.endsWith('@lid')) return 'lid'
  if (raw.endsWith('@g.us')) return 'group'
  if (raw.endsWith('@c.us') || raw.endsWith('@s.whatsapp.net')) return 'phone'
  return 'unknown'
}

export function phoneFromJid(jid) {
  if (!jid) return null
  if (jidKind(jid) !== 'phone') return null
  const raw = String(jid)
  const local = raw.split('@')[0].split(':')[0]
  const digits = local.replace(/\D/g, '')
  return digits.length >= 8 ? digits : null
}

export function isGroupJid(jid) {
  return jidKind(jid) === 'group'
}

export function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback
  const v = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false
  return fallback
}
