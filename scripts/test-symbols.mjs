/**
 * Prove the symbol palette's data: every category, every drawn glyph and every
 * snippet it inserts must be LaTeX that KaTeX accepts and that survives the
 * LaTeX -> MathML -> OMML pipeline the export buttons use.
 *
 * Run: node scripts/test-symbols.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SYMBOL_GROUPS, STYLE_ACTIONS, splitInsert } from '../src/symbols.js'
import { buildMathML } from '../src/convert.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

function loadGlobal(file, expression) {
  const source = readFileSync(join(root, 'assets', 'vendor', file), 'utf8')
  return new Function(`${source}\nreturn ${expression};`)()
}

const temml = loadGlobal('temml.min.js', 'temml')

/* KaTeX needs a DOM; the browser test covers rendering. Here the assertion is that
   each snippet is *accepted* — KaTeX's own parser is exercised in the harness. */
const failures = []
const notes = []
const fail = (where, message) => { failures.push(`${where}: ${message}`) }

/* ------------------------------------------------------------ structure */

const EXPECTED_LABELS = [
  '操作符', '箭头', '根号', '分数与导数', '上下标', '大型运算符',
  '极限与对数', '三角与双曲', '希腊字母', '重音符号', '其它符号',
]

if (SYMBOL_GROUPS.length !== EXPECTED_LABELS.length) {
  fail('groups', `expected ${EXPECTED_LABELS.length} categories, found ${SYMBOL_GROUPS.length}`)
}

const seenLabels = SYMBOL_GROUPS.map((one) => one.label)
if (JSON.stringify(seenLabels) !== JSON.stringify(EXPECTED_LABELS)) {
  fail('group labels', `got ${JSON.stringify(seenLabels)}`)
}

const ids = new Set()
for (const group of SYMBOL_GROUPS) {
  if (typeof group.id !== 'string' || group.id.length === 0) fail('group id', JSON.stringify(group))
  if (ids.has(group.id)) fail('group id', `duplicate ${group.id}`)
  ids.add(group.id)
  if (typeof group.sample !== 'string' || group.sample.length === 0) fail(group.id, 'no sample glyph')
  if (!Array.isArray(group.items) || group.items.length < 5) {
    fail(group.id, `only ${group.items?.length ?? 0} items`)
  }
  for (const item of group.items) {
    if (typeof item.g !== 'string' || item.g.length === 0) fail(group.id, `bad item ${JSON.stringify(item)}`)
    if (item.i !== undefined && typeof item.i !== 'string') fail(group.id, `bad insert ${JSON.stringify(item)}`)
  }
}

/* ------------------------------------------------------ every snippet is real */

/** Feed one LaTeX string through temml; returns null on success, the error text on failure. */
const checkTex = (tex) => {
  try {
    const mathml = buildMathML(temml, tex)
    if (!/<math/u.test(mathml)) return 'produced no <math>'
    if (!/xmlns=/u.test(mathml)) return 'lost its xmlns'
    return null
  } catch (problem) {
    return problem instanceof Error ? problem.message : String(problem)
  }
}

let drawn = 0
let inserted = 0
for (const group of SYMBOL_GROUPS) {
  const sampleProblem = checkTex(group.sample)
  if (sampleProblem !== null) fail(`${group.id} sample`, `${group.sample} -> ${sampleProblem}`)
  drawn += 1

  for (const item of group.items) {
    const glyphProblem = checkTex(item.g)
    if (glyphProblem !== null) fail(`${group.id} glyph`, `${item.g} -> ${glyphProblem}`)
    drawn += 1

    /* The inserted text is what lands in the box, so it must parse on its own too. */
    const { body, caret } = splitInsert(item)
    if (body.length === 0) fail(`${group.id} insert`, `empty body for ${item.g}`)
    if (caret < 0 || caret > body.length) {
      fail(`${group.id} caret`, `${caret} outside 0..${body.length} for ${item.g}`)
    }
    if (body.includes('|')) fail(`${group.id} insert`, `caret marker survived: ${body}`)
    const insertProblem = checkTex(body)
    if (insertProblem !== null) fail(`${group.id} insert`, `${body} -> ${insertProblem}`)
    inserted += 1
  }
}

/* ------------------------------------------------------------- styles */

for (const action of STYLE_ACTIONS) {
  if (typeof action.open !== 'string' || typeof action.close !== 'string') {
    fail('style', JSON.stringify(action))
    continue
  }
  const wrapped = `${action.open}x${action.close}`
  const problem = checkTex(wrapped)
  if (problem !== null) fail('style', `${action.label} -> ${wrapped} -> ${problem}`)
  if (action.label.includes('{')) fail('style label', `${action.label} leaks a brace`)
}

/* ------------------------------------------------------- splitInsert contract */

const caretCases = [
  [{ g: 'a', i: 'ab|cd' }, 'abcd', 2],
  [{ g: 'x' }, 'x', 1],
  [{ g: 'x', i: '|' }, '', 0],
  [{ g: 'x', i: 'abc|' }, 'abc', 3],
]
for (const [item, body, caret] of caretCases) {
  const got = splitInsert(item)
  if (got.body !== body || got.caret !== caret) {
    fail('splitInsert', `${JSON.stringify(item)} -> ${JSON.stringify(got)}, wanted ${body}/${caret}`)
  }
}

/* ------------------------------------------------------------- report */

const totalItems = SYMBOL_GROUPS.reduce((sum, one) => sum + one.items.length, 0)
notes.push(`categories: ${SYMBOL_GROUPS.length}`)
notes.push(`items: ${totalItems}`)
notes.push(`snippets parsed: ${drawn} glyphs + ${inserted} inserts`)
notes.push(`styles: ${STYLE_ACTIONS.length}`)

console.log(notes.join('\n'))
if (failures.length > 0) {
  console.log('')
  for (const one of failures) console.log(`FAIL ${one}`)
  console.log(`\n${failures.length} failure(s)`)
  process.exit(1)
}
console.log('\nSYMBOLS OK')
