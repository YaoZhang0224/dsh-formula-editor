/* Build the distributable tarball: the same files `npm pack` would take, so the
 * plugin can be installed with one `plugin_manager install_bundle` call without
 * needing the source tree, the scripts, or a git checkout.
 *
 *   node scripts/pack.mjs [--out <dir>]
 *
 * The tarball is written to <repo>/dist by default. `npm pack` is driven through
 * Node directly because PowerShell refuses to run npm.ps1 under the default
 * execution policy. */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = resolve(HERE, '..')
const NODE = process.execPath

/* The npm CLI ships beside the Node build that runs this script. */
const NPM_CLI = join(dirname(NODE), 'node_modules', 'npm', 'bin', 'npm-cli.js')

const manifest = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'))

const outFlag = process.argv.indexOf('--out')
const outDir = outFlag > 0 && process.argv[outFlag + 1] !== undefined
  ? resolve(process.argv[outFlag + 1])
  : join(PKG, 'dist')

if (!existsSync(NPM_CLI)) {
  console.error(`PACK FAILED — no npm CLI beside this Node: ${NPM_CLI}`)
  process.exit(1)
}

/* A stale bundle would ship the previous UI, so rebuild before packing. */
console.log('building client.js first…')
execFileSync(NODE, [join(HERE, 'build-client.mjs')], { cwd: PKG, stdio: 'inherit' })

mkdirSync(outDir, { recursive: true })

console.log(`packing ${manifest.name}@${manifest.version} into ${outDir}…`)
const printed = execFileSync(NODE, [NPM_CLI, 'pack', '--pack-destination', outDir], {
  cwd: PKG, encoding: 'utf8',
}).trim()
const fileName = printed.split(/\r?\n/u).filter((line) => line.trim().length > 0).pop().trim()
const tarball = join(outDir, fileName)

if (!existsSync(tarball)) {
  console.error(`PACK FAILED — npm did not write ${tarball}`)
  process.exit(1)
}

/* Verify what went in: every file the manifest promises, and nothing from the
 * build-only directories that would only confuse a recipient. The dry run is a
 * second, cheap pass that reports exactly the same file list without writing. */
const listing = execFileSync(NODE, [NPM_CLI, 'pack', '--dry-run', '--json'], {
  cwd: PKG, encoding: 'utf8',
})
const packed = new Set(JSON.parse(listing)[0].files.map((file) => file.path))

const problems = []
const required = [
  'package.json', 'index.js', 'client.js', 'cordis.patch.yml', 'icon.png', 'README.md', 'LICENSE',
  'assets/katex/katex.min.css', 'assets/katex/katex.min.js',
  'assets/mathlive/mathlive.min.js', 'assets/mathlive/mathlive-static.css', 'assets/mathlive/mathlive-fonts.css',
  'assets/vendor/temml.min.js', 'assets/vendor/mathml2omml.js', 'assets/vendor/tex2typst.min.js',
]
for (const wanted of required) {
  if (!packed.has(wanted)) problems.push(`missing from the tarball: ${wanted}`)
}
const fonts = [...packed].filter((path) => path.startsWith('assets/katex/fonts/'))
if (fonts.length !== 20) problems.push(`expected 20 KaTeX fonts, found ${fonts.length}`)
for (const path of packed) {
  if (path.startsWith('src/') || path.startsWith('scripts/') || path.startsWith('test/') || path.startsWith('node_modules/')) {
    problems.push(`build-only file leaked into the tarball: ${path}`)
  }
}

const size = statSync(tarball).size
const kib = (size / 1024).toFixed(0)

if (problems.length > 0) {
  console.error(`PACK PROBLEMS (${problems.length})`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(`files: ${packed.size} / fonts: ${fonts.length}`)
console.log(`tarball: ${tarball} (${size} bytes, ${kib} KiB)`)
console.log('PACK OK')
