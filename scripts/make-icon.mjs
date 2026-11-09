// Build the plugin icon from the 512x512 master kept in scripts/.
//
// The master (scripts/icon-source.png) is the user-supplied logo, cut out of its
// white background: alpha is recovered as `1 - min(r,g,b)/254` and the colour is
// un-premultiplied against it, then the ink is cropped to its bounding box and
// padded back to a square. Keeping the master here means the shipped icon.png is
// reproducible instead of being an opaque blob in the repository root.
//
// DSH reads this file as the plugin artwork: app-boot's `iconOf` admits
// svg/png/jpg/jpeg/webp and rejects anything over MAX_ICON_BYTES = 256 KiB, so the
// size assertion below is what keeps a future re-export from silently losing the
// icon (an oversized icon makes readPluginMeta fail, which drops the artwork and
// prints a red diagnostic under the plugin row).
import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const MASTER = join(HERE, 'icon-source.png')
const TARGET = join(ROOT, 'icon.png')
const MAX_ICON_BYTES = 256 * 1024

function fail(message) {
  process.stderr.write(`ICON FAILED: ${message}\n`)
  process.exit(1)
}

let bytes
try {
  bytes = readFileSync(MASTER)
} catch (error) {
  fail(`cannot read ${MASTER}: ${error.message}`)
}

// PNG magic, so a re-export that lands as JPEG or WebP is caught here rather than
// in DSH's metadata reader.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
if (!bytes.subarray(0, 8).equals(PNG_MAGIC)) fail('the master is not a PNG file')

// IHDR: width and height are big-endian uint32 at offsets 16 and 20.
const width = bytes.readUInt32BE(16)
const height = bytes.readUInt32BE(20)
const colourType = bytes.readUInt8(25)
if (width !== height) fail(`the master must be square, got ${width}x${height}`)
if (colourType !== 6) fail(`the master must be RGBA (colour type 6), got ${colourType}`)

writeFileSync(TARGET, bytes)
const size = statSync(TARGET).size
if (size > MAX_ICON_BYTES) fail(`${TARGET} is ${size} B, over DSH's ${MAX_ICON_BYTES} B icon limit`)

process.stdout.write(`icon: ${width}x${height} RGBA, ${size} B -> ${TARGET}\n`)
process.stdout.write(`icon budget: ${size} / ${MAX_ICON_BYTES} B\n`)
process.stdout.write('ICON OK\n')
