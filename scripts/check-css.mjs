import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const file = join(HERE, '..', 'src', 'client-ui.js')
const source = readFileSync(file, 'utf8')
const start = source.indexOf('const CSS = ' + String.fromCharCode(96))
if (start < 0) throw new Error('CSS block not found')
const bodyStart = start + ('const CSS = ' + String.fromCharCode(96)).length
const bodyEnd = source.indexOf(String.fromCharCode(96), bodyStart)
const body = source.slice(bodyStart, bodyEnd)
const ticks = [...body].reduce((all, ch, index) => (ch === String.fromCharCode(96) ? [...all, index] : all), [])
console.log('CSS block chars:', body.length)
console.log('backticks inside:', ticks.length)
console.log('dollar-brace inside:', (body.match(/\$\{/g) ?? []).length)
if (ticks.length > 0) {
  for (const at of ticks) console.log('  at', at, JSON.stringify(body.slice(Math.max(0, at - 70), at + 30)))
}
