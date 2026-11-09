/**
 * Copy the MathLive runtime assets into the plugin's asset tree.
 *
 * MathLive is the editing surface: the preview box becomes a real math field
 * the user can type into. Only the browser bundle and its two stylesheets are
 * needed; the fonts are already shipped for KaTeX and MathLive uses the same
 * KaTeX faces, so the font stylesheet is rewritten to point at ../katex/fonts.
 *
 * Usage: node scripts/fetch-mathlive.mjs [<extracted-package-dir>]
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SOURCE = resolve(process.argv[2] ?? join(ROOT, 'mathlive-package'))
const TARGET = join(ROOT, 'assets', 'mathlive')

const FILES = ['mathlive.min.js', 'mathlive-static.css', 'mathlive-fonts.css', 'LICENSE.txt']

if (!existsSync(SOURCE)) {
  console.error(`MathLive package not found at ${SOURCE}`)
  console.error('Download it first:')
  console.error('  npm pack mathlive@0.111.4 && tar -xzf mathlive-0.111.4.tgz')
  console.error('  node scripts/fetch-mathlive.mjs ./package')
  process.exit(1)
}

mkdirSync(TARGET, { recursive: true })

for (const name of FILES) {
  const from = join(SOURCE, name)
  if (!existsSync(from)) {
    console.error(`missing ${from}`)
    process.exit(1)
  }
  const to = name === 'LICENSE.txt' ? join(ROOT, 'vendor', 'LICENSE-mathlive') : join(TARGET, name)
  copyFileSync(from, to)
  console.log(`copied ${name}`)
}

/* The font stylesheet ships with relative url(fonts/...) references. KaTeX's
 * woff2 files already live in assets/katex/fonts, so repoint instead of
 * shipping the same 20 files twice. */
const fontsCss = readFileSync(join(TARGET, 'mathlive-fonts.css'), 'utf8')
const rewritten = fontsCss.replace(/url\(fonts\//gu, 'url(../katex/fonts/')
writeFileSync(join(TARGET, 'mathlive-fonts.css'), rewritten, 'utf8')
console.log(`rewrote ${(fontsCss.match(/url\(fonts\//gu) ?? []).length} font urls to ../katex/fonts/`)

/* The layout stylesheet repeats the same 20 @font-face rules with the same
 * broken relative path. Drop them: the rewritten font stylesheet above is the
 * single source of truth, so the browser never requests a missing file. */
const staticCss = readFileSync(join(TARGET, 'mathlive-static.css'), 'utf8')
const stripped = staticCss.replace(/@font-face\{[^}]*\}/gu, '')
writeFileSync(join(TARGET, 'mathlive-static.css'), stripped, 'utf8')
console.log(`dropped ${(staticCss.match(/@font-face\{/gu) ?? []).length} duplicate @font-face rules`)

