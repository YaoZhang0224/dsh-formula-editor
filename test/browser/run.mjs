/**
 * Drive the browser harness end to end and print the PASS/FAIL lines.
 *
 *   node test/browser/run.mjs [--budget <ms>] [--keep]
 *
 * Starts the static server on an ephemeral port, points a headless Chrome at
 * `?selftest=1`, waits for the page to finish, and reports the results block the
 * page wrote into the DOM. Exits non-zero when any check failed.
 *
 * The browser is discovered from `CHROME` / `CHROME_PATH` first, then from the
 * usual install locations per platform, so no absolute path is baked in.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

const argument = (name, fallback) => {
  const at = process.argv.indexOf(name)
  return at > 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1] : fallback
}

const budget = Number(argument('--budget', '60000'))
const keep = process.argv.includes('--keep')

/** The headless browser, from the environment or the platform's default spots. */
function findBrowser() {
  const explicit = process.env.CHROME ?? process.env.CHROME_PATH
  if (explicit !== undefined && explicit.length > 0) {
    if (!existsSync(explicit)) throw new Error(`CHROME points at a missing file: ${explicit}`)
    return explicit
  }
  const candidates = {
    win32: [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ],
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ],
    linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'],
  }[process.platform] ?? []
  for (const one of candidates) if (existsSync(one)) return one
  throw new Error('no Chrome or Edge found; set CHROME to the browser executable')
}

const browser = findBrowser()
const scratch = mkdtempSync(join(tmpdir(), 'dsffe-test-'))

console.log(`browser: ${browser}`)

const server = spawn(process.execPath, [join(HERE, 'serve.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] })
let serverOutput = ''
server.stdout.on('data', (chunk) => { serverOutput += String(chunk) })
server.stderr.on('data', (chunk) => { serverOutput += String(chunk) })

/** Wait for the server to announce its port. */
async function portOf() {
  const started = Date.now()
  while (Date.now() - started < 15000) {
    const found = /127\.0\.0\.1:(\d+)/.exec(serverOutput)
    if (found !== null) return found[1]
    if (server.exitCode !== null) throw new Error(`the harness server exited early\n${serverOutput}`)
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error(`the harness server never reported a port\n${serverOutput}`)
}

let failed = false
try {
  const url = `http://127.0.0.1:${await portOf()}/?selftest=1`
  console.log(`harness: ${url}`)

  /* Chrome writes the serialized DOM to stdout under --dump-dom, and
   * --virtual-time-budget keeps the page alive until its async chain settles. */
  const dump = execFileSync(browser, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--hide-scrollbars', '--window-size=1200,900',
    `--virtual-time-budget=${String(budget)}`,
    '--dump-dom', url,
  ], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' })

  const results = /<pre id="results">([\s\S]*?)<\/pre>/.exec(dump)?.[1] ?? ''
  if (results.length === 0) {
    console.error('no results block: the page did not run the self test')
    console.error(dump.slice(0, 2000))
    failed = true
  } else {
    const decoded = results
      .replaceAll('&lt;', '<').replaceAll('&gt;', '>')
      .replaceAll('&amp;', '&').replaceAll('&quot;', '"')
    console.log(decoded)
    const failures = decoded.split('\n').filter((line) => line.startsWith('FAIL '))
    if (failures.length > 0) {
      console.error(`\n${String(failures.length)} FAILED`)
      failed = true
    } else {
      console.log('\nALL PASS')
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  failed = true
} finally {
  if (server.exitCode === null) server.kill('SIGKILL')
  if (keep) console.log(`scratch kept at ${scratch}`)
  else rmSync(scratch, { recursive: true, force: true })
}

if (failed) process.exit(1)
