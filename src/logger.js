const LEVELS = { silent: 99, error: 40, warn: 30, info: 20, debug: 10, trace: 0 }

export function createLogger(level = 'info', prefix = 'chatrail') {
  const threshold = LEVELS[level] ?? LEVELS.info
  const emit = (name, ...args) => {
    if ((LEVELS[name] ?? 100) < threshold) return
    const line = `[${new Date().toISOString()}] [${prefix}] [${name.toUpperCase()}]`
    const fn = name === 'error' ? console.error : name === 'warn' ? console.warn : console.log
    fn(line, ...args)
  }

  const logger = {
    level,
    trace: (...a) => emit('trace', ...a),
    debug: (...a) => emit('debug', ...a),
    info: (...a) => emit('info', ...a),
    warn: (...a) => emit('warn', ...a),
    error: (...a) => emit('error', ...a),
    fatal: (...a) => emit('error', ...a),
    child: (bindings = {}) => createLogger(level, `${prefix}:${bindings.module || bindings.component || 'child'}`)
  }

  return logger
}
