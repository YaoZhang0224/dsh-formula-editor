/**
 * Verify that dsh-formula-editor is installed in this DSH profile and that the
 * profile sees exactly the files this source tree produces.
 *
 * A bundle installed with `link:` is a junction from the profile's node_modules
 * back to this directory, so the profile keeps working as long as (a) the
 * junction exists, (b) the profile's package.json still lists the bundle, and
 * (c) client.js is a current build. This script checks all three and prints the
 * one command that repairs each of them.
 *
 * Run: node scripts/verify-install.mjs [--profile <dir>]
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PACKAGE = 'dsh-formula-editor'

const argv = process.argv.slice(2)
const profileIndex = argv.indexOf('--profile')
const profile = profileIndex >= 0 && argv[profileIndex + 1]
  ? resolve(argv[profileIndex + 1])
  : join(homedir(), '.dsh', 'profiles', 'desktop')

const problems = []
const notes = []

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** Every file this bundle ships, mirroring package.json "files". */
function shippedFiles() {
  const listed = []
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  for (const entry of manifest.files ?? []) {
    const path = join(ROOT, entry)
    if (!existsSync(path)) continue
    if (statSync(path).isDirectory()) {
      for (const name of readdirSync(path)) listed.push(join(entry, name))
    } else {
      listed.push(entry)
    }
  }
  return listed
}

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
notes.push(`source   ${ROOT}`)
notes.push(`package  ${manifest.name}@${manifest.version}`)
notes.push(`profile  ${profile}`)

if (!existsSync(profile)) {
  problems.push(`profile directory missing: ${profile}\n  install with: plugin_manager install_bundle ${ROOT}`)
} else {
  const profileManifestPath = join(profile, 'package.json')
  if (!existsSync(profileManifestPath)) {
    problems.push(`profile package.json missing: ${profileManifestPath}`)
  } else {
    const profileManifest = JSON.parse(readFileSync(profileManifestPath, 'utf8'))
    const bundles = profileManifest?.dsh?.profile?.bundles ?? []
    if (!bundles.includes(PACKAGE)) {
      problems.push(`profile package.json does not list "${PACKAGE}" in dsh.profile.bundles\n  install with: plugin_manager install_bundle ${ROOT}`)
    } else {
      notes.push('profile manifest lists the bundle: yes')
    }
    const dependency = profileManifest?.dependencies?.[PACKAGE]
    if (typeof dependency !== 'string') {
      problems.push(`profile package.json has no dependency entry for "${PACKAGE}"`)
    } else if (!dependency.startsWith('link:')) {
      notes.push(`dependency is not a link: ${dependency} (a copied install still works, but a rebuild here will not reach the profile)`)
    }
  }

  const installed = join(profile, 'node_modules', PACKAGE)
  if (!existsSync(installed)) {
    problems.push(`profile node_modules has no ${PACKAGE} link\n  install with: plugin_manager install_bundle ${ROOT}`)
  } else {
    let target = ''
    try {
      target = realpathSync(installed)
    } catch (error) {
      problems.push(`cannot resolve ${installed}: ${error.message}`)
    }
    if (target !== '') {
      const same = resolve(target) === resolve(ROOT)
      notes.push(`node_modules link -> ${target}`)
      if (!same) {
        notes.push('the link points at another copy of the plugin; rebuilding here will not reach the profile')
      }
    }

    let mismatched = 0
    let compared = 0
    for (const entry of shippedFiles()) {
      const left = join(ROOT, entry)
      const right = join(installed, entry)
      if (!existsSync(right)) {
        problems.push(`the profile copy is missing ${entry}`)
        mismatched += 1
        continue
      }
      if (!existsSync(left)) continue
      compared += 1
      if (sha256(left) !== sha256(right)) {
        problems.push(`the profile copy of ${entry} differs from this build (rebuild with: node scripts/build-client.mjs)`)
        mismatched += 1
      }
    }
    notes.push(`files compared: ${compared} (mismatched: ${mismatched})`)
  }
}

const clientPath = join(ROOT, 'client.js')
if (!existsSync(clientPath)) {
  problems.push('client.js is missing; build it with: node scripts/build-client.mjs')
} else {
  const bundle = readFileSync(clientPath, 'utf8')
  if (!bundle.includes(`id: '${PACKAGE}'`)) {
    problems.push('client.js does not register the expected module id; rebuild it')
  }
  if (!/\.dsffe-palette \{/.test(bundle)) {
    problems.push('client.js looks stale (no palette CSS); rebuild it')
  }
  notes.push(`client.js ${readFileSync(clientPath).length} bytes`)
}

for (const line of notes) console.log(line)
if (problems.length === 0) {
  console.log('\nINSTALL OK — the profile runs this source tree; a page reload picks up new builds.')
  process.exit(0)
}
console.log('\nINSTALL PROBLEMS')
for (const line of problems) console.log(`- ${line}`)
process.exit(1)
