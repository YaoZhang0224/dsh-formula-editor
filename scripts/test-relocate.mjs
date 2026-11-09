/**
 * Validate that a *relocated copy* of the plugin works from a different absolute
 * path — i.e. that nothing depends on where the source tree lives. This is the
 * assumption a friend's machine relies on.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = join(HERE, '..')
/* A fresh directory outside the repository, with a space in its name: the case
 * a friend's machine is most likely to hit and the one a naive path join breaks. */
const TARGET = join(tmpdir(), 'dsh formula editor relocate', 'dsh-formula-editor')

rmSync(dirname(TARGET), { recursive: true, force: true })
cpSync(SOURCE, TARGET, {
  recursive: true,
  filter: (from) => !/[\\/](node_modules|\.git)$/.test(from),
})

const problems = []
const ok = (label, condition, detail) => {
  if (condition) console.log(`ok   ${label}${detail === undefined ? '' : ` :: ${detail}`}`)
  else problems.push(`${label}${detail === undefined ? '' : ` :: ${detail}`}`)
}

// 1. The host half imports from its new home and resolves its assets there.
const host = await import(pathToFileURL(join(TARGET, 'index.js')).href)
ok('host exports name', host.name === 'dsh-formula-editor', host.name)
ok('host exports apply', typeof host.apply === 'function')
ok('host requires webServer', Array.isArray(host.inject) && host.inject.includes('webServer'))
ok('host exports Config', typeof host.Config?.['~standard']?.validate === 'function')

// 2. Every asset the routes serve is present in the copy.
const pkg = JSON.parse(readFileSync(join(TARGET, 'package.json'), 'utf8'))
const wanted = [
  'assets/katex/katex.min.css',
  'assets/katex/katex.min.js',
  'assets/mathlive/mathlive.min.js',
  'assets/mathlive/mathlive-static.css',
  'assets/mathlive/mathlive-fonts.css',
  'assets/vendor/temml.min.js',
  'assets/vendor/mathml2omml.js',
  'assets/vendor/tex2typst.min.js',
  'client.js',
  'cordis.patch.yml',
  'icon.png',
  'locale/zh.json',
  'locale/en.json',
]
for (const one of wanted) ok(`asset ${one}`, existsSync(join(TARGET, one)))

const fonts = readFileSync(join(TARGET, 'assets/mathlive/mathlive-fonts.css'), 'utf8')
ok('mathlive fonts point at ../katex/fonts', !fonts.includes('url(fonts/') && fonts.includes('url(../katex/fonts/'))

// 3. The built client bundle is valid JavaScript and registers the loader contract.
const client = readFileSync(join(TARGET, 'client.js'), 'utf8')
execFileSync(process.execPath, ['--check', join(TARGET, 'client.js')], { stdio: 'pipe' })
ok('client.js parses', true, `${client.length} bytes`)
ok('client.js uses the module loader', client.includes('__ModuleLoader__.load'))
ok('client.js registers the plugin id', client.includes("id: 'dsh-formula-editor'") || client.includes('id:"dsh-formula-editor"'))
ok('client.js inlines the converters', client.includes('FormulaConvert') && client.includes('FormulaSymbols'))

// 4. No absolute path from the build machine leaked into a shipped file.
const leaks = []
for (const one of ['client.js', 'index.js', 'cordis.patch.yml', 'package.json']) {
  const text = readFileSync(join(TARGET, one), 'utf8')
  if (text.includes('D:\\') || text.includes('D:/')) leaks.push(one)
}
ok('no build-machine paths in shipped files', leaks.length === 0, leaks.join(', ') || 'none')

// 5. The dependency list is honest: nothing outside the package is required at runtime.
ok('no runtime dependencies', pkg.dependencies === undefined || Object.keys(pkg.dependencies).length === 0)
ok('declares the bundle patch', pkg.dsh?.bundle?.patch === './cordis.patch.yml')
ok('declares a web client', pkg.dsh?.client?.platform === 'web')

// 6. The icon is shipped, reachable both ways DSH looks for it, and inside the size
// budget: an icon over MAX_ICON_BYTES (256 KiB) makes readPluginMeta fail, which
// drops the artwork and prints a red diagnostic under the plugin row.
ok('manifest names the icon', pkg.icon === 'icon.png', pkg.icon ?? 'absent')
ok('the icon export resolves', pkg.exports?.['./icon'] === './icon.png', pkg.exports?.['./icon'] ?? 'absent')
const iconSize = statSync(join(TARGET, 'icon.png')).size
ok('the icon is within the DSH budget', iconSize <= 256 * 1024, `${iconSize} B`)

console.log('')
console.log(`relocated to: ${TARGET}`)
if (problems.length === 0) console.log('RELOCATE OK — the plugin runs from any absolute path')
else {
  console.log(`RELOCATE PROBLEMS (${problems.length})`)
  for (const one of problems) console.log(`  - ${one}`)
  process.exitCode = 1
}
