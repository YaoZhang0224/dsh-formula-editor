/**
 * Exercise src/convert.js in Node: MathML, OMML, AsciiMath, Typst and .docx for a
 * set of formulas that cover the constructs the editor has to handle.
 *
 * Run: node scripts/test-convert.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildDocxBytes,
  buildMathML,
  buildWordHtml,
  toAsciimath,
  toOmml,
} from '../src/convert.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const outDir = join(root, '.test-out')
mkdirSync(outDir, { recursive: true })

/** Load a browser global-style bundle by evaluating its source. */
function loadGlobal(file, expression) {
  const source = readFileSync(join(root, 'assets', 'vendor', file), 'utf8')
  return new Function(`${source}\nreturn ${expression};`)()
}

const temml = loadGlobal('temml.min.js', 'temml')
const mml2omml = loadGlobal('mathml2omml.js', 'globalThis.__mml2omml')

/* typst is a UMD/IIFE that assigns onto its global object. */
const typstSource = readFileSync(join(root, 'assets', 'vendor', 'tex2typst.min.js'), 'utf8')
const typstGlobal = {}
new Function('window', 'self', 'globalThis', typstSource)(typstGlobal, typstGlobal, typstGlobal)
const tex2typst = typstGlobal.tex2typst

const CASES = {
  einstein: 'E = mc^2',
  quadratic: 'x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}',
  gauss: '\\int_{0}^{\\infty} \\frac{x^3}{e^x-1}\\,dx = \\frac{\\pi^4}{15}',
  basel: '\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}',
  pmatrix: '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}',
  limit: '\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1',
  schrodinger: 'i\\hbar\\frac{\\partial}{\\partial t}\\Psi = \\hat{H}\\Psi',
  cauchy: '\\left(\\sum_{k=1}^{n} a_k b_k\\right)^2 \\leq \\left(\\sum_{k=1}^{n} a_k^2\\right)\\left(\\sum_{k=1}^{n} b_k^2\\right)',
  mixed: '\\sqrt[3]{x^2+1} + \\overline{z} + \\vec{v} + \\tilde{a}',
  wave: '\\frac{\\partial^2 u}{\\partial t^2} = c^2 \\nabla^2 u',
  cases: 'f(x) = \\begin{cases} x^2 & x > 0 \\\\ 0 & x \\leq 0 \\end{cases}',
  text: '\\text{if } x > 0 \\text{ then } y = \\log_2 x',
}

const report = []
let failures = 0
const fail = (name, message) => {
  failures += 1
  report.push(`FAIL ${name}: ${message}`)
}

for (const [name, tex] of Object.entries(CASES)) {
  let mml
  let omml
  try {
    mml = buildMathML(temml, tex)
  } catch (error) {
    fail(name, `mathml threw: ${error.message}`)
    continue
  }
  if (!mml.includes('xmlns="http://www.w3.org/1998/Math/MathML"')) fail(name, 'mathml lost its xmlns')
  if (/\sclass=|\sstyle=|<mspace/u.test(mml)) fail(name, 'mathml kept presentational noise')

  try {
    omml = toOmml(temml, mml2omml, tex)
  } catch (error) {
    fail(name, `omml threw: ${error.message}`)
    continue
  }
  if (!omml.startsWith('<m:oMath')) fail(name, 'omml does not start with m:oMath')
  if (/\bm:acc\b/.test(omml) === false && /\\hat|\\vec|\\bar|\\tilde|\\dot|\\ddot/u.test(tex)) {
    fail(name, 'an accent did not become m:acc')
  }
  if (/\\hat/u.test(tex) && /<m:limUpp>/u.test(omml)) fail(name, 'hat became a stacked limit')

  const ascii = toAsciimath(tex)
  if (ascii.length === 0) fail(name, 'asciimath is empty')
  if (/\\[a-zA-Z]/u.test(ascii)) fail(name, `asciimath kept a TeX command: ${ascii}`)

  let typst = ''
  try {
    typst = tex2typst(tex)
  } catch (error) {
    fail(name, `typst threw: ${error.message}`)
  }
  if (typst.length === 0) fail(name, 'typst is empty')

  let docx = 0
  try {
    docx = buildDocxBytes(omml).length
  } catch (error) {
    fail(name, `docx threw: ${error.message}`)
  }
  if (docx < 1000) fail(name, 'docx is implausibly small')

  report.push(
    `${name}\n  mathml  ${mml.length} ch\n  omml    ${omml.length} ch\n  asciimath  ${ascii}\n  typst   ${typst}\n  docx    ${docx} B`,
  )

  if (name === 'schrodinger') {
    writeFileSync(join(outDir, 'schrodinger.docx'), buildDocxBytes(omml))
    writeFileSync(join(outDir, 'schrodinger.mml'), mml)
    writeFileSync(join(outDir, 'schrodinger.omml'), omml)
    writeFileSync(join(outDir, 'schrodinger.html'), buildWordHtml(temml, tex))
  }
  if (name === 'gauss') {
    writeFileSync(join(outDir, 'gauss.docx'), buildDocxBytes(omml))
    writeFileSync(join(outDir, 'gauss.html'), buildWordHtml(temml, tex))
    writeFileSync(join(outDir, 'gauss.mml'), mml)
    writeFileSync(join(outDir, 'gauss.omml'), omml)
  }
  if (name === 'pmatrix') writeFileSync(join(outDir, 'pmatrix.docx'), buildDocxBytes(omml))
  if (name === 'mixed') writeFileSync(join(outDir, 'mixed.docx'), buildDocxBytes(omml))
  if (name === 'cases') writeFileSync(join(outDir, 'cases.docx'), buildDocxBytes(omml))
  if (name === 'quadratic') writeFileSync(join(outDir, 'quadratic.docx'), buildDocxBytes(omml))
}

writeFileSync(join(outDir, 'report.txt'), report.join('\n\n'), 'utf8')
console.log(report.join('\n\n'))
console.log(`\n${failures === 0 ? 'ALL OK' : failures + ' FAILURE(S)'}`)
process.exitCode = failures === 0 ? 0 : 1
