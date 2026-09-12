import { runDoctor } from '../src/doctor.js'

const ok = await runDoctor()
process.exit(ok ? 0 : 1)
