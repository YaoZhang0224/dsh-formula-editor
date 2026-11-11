/**
 * The sidebar tab for dsh-formula-editor: image -> LaTeX recognition, a live KaTeX
 * preview, and the two copy buttons.
 *
 * Bundled into client.js by scripts/build-client.mjs, which inlines src/convert.js
 * ahead of this file so the pure conversion code is shared with the Node tests.
 * `FormulaConvert` (this plugin's own conversions) and the vendor globals
 * (`katex`, `temml`, `globalThis.__mml2omml`, `window.tex2typst`) are what it expects.
 */

const ROUTE_OCR = '/plugins/dsh-formula-editor/ocr'
const ROUTE_SETTINGS = '/plugins/dsh-formula-editor/settings'
const ASSETS = '/plugins/dsh-formula-editor/assets'

/* Wide enough for the symbol galleries; used to decide which way they open.
   Must stay in step with --dsffe-menu-w in the stylesheet. */
const MENU_WIDTH = 300
const EDGE_GAP = 12

const TAB_ID = 'dsh-formula-editor:editor'

/* The left navigation entry's id doubles as its main-panel key: the sidebar row
 * selects the panel by the same id the `main` slot is registered under. */
const PANEL_ID = 'dsh-formula-editor'

/* ------------------------------------------------------------------ *
 * Vendor assets
 * ------------------------------------------------------------------ */

/** Same-origin `<script>` loading, cached per URL so remounts cost nothing. */
const scriptCache = new Map()

function loadScript(url) {
  const existing = scriptCache.get(url)
  if (existing !== undefined) return existing
  const pending = new Promise((accept, refuse) => {
    const element = document.createElement('script')
    element.src = url
    element.async = true
    element.onload = () => { accept(true) }
    element.onerror = () => { refuse(new Error(`failed to load ${url}`)) }
    document.head.appendChild(element)
  })
  scriptCache.set(url, pending)
  return pending
}

/** Load KaTeX once, with the stylesheet that points at the bundled fonts. */
const katexReady = (() => {
  let pending = null
  return () => {
    if (pending !== null) return pending
    pending = (async () => {
      if (document.getElementById('dsh-formula-editor-katex-css') === null) {
        const link = document.createElement('link')
        link.id = 'dsh-formula-editor-katex-css'
        link.rel = 'stylesheet'
        link.href = `${ASSETS}/katex/katex.min.css`
        document.head.appendChild(link)
      }
      await loadScript(`${ASSETS}/katex/katex.min.js`)
      return window.katex
    })()
    return pending
  }
})()

/** Load the three conversion libraries, in the order their globals appear. */
const convertReady = (() => {
  let pending = null
  return () => {
    if (pending !== null) return pending
    pending = (async () => {
      await loadScript(`${ASSETS}/vendor/temml.min.js`)
      await loadScript(`${ASSETS}/vendor/mathml2omml.js`)
      await loadScript(`${ASSETS}/vendor/tex2typst.min.js`)
      return {
        temml: window.temml,
        mml2omml: globalThis.__mml2omml,
        tex2typst: window.tex2typst,
      }
    })()
    return pending
  }
})()

/**
 * Load MathLive, the editable formula surface.
 *
 * MathLive renders with the same KaTeX faces the preview already ships, so its
 * own font stylesheet is pointed at those files and MathLive itself is told not
 * to fetch fonts (`fontsDirectory = null`). The virtual keyboard is forced to
 * manual: this is a desktop editor, and the on-screen keyboard would cover the
 * panel.
 */
const mathliveReady = (() => {
  let pending = null
  return () => {
    if (pending !== null) return pending
    pending = (async () => {
      const sheets = [
        ['dsh-formula-editor-mathlive-css', 'mathlive-static.css'],
        ['dsh-formula-editor-mathlive-fonts', 'mathlive-fonts.css'],
      ]
      for (const [id, file] of sheets) {
        if (document.getElementById(id) === null) {
          const link = document.createElement('link')
          link.id = id
          link.rel = 'stylesheet'
          link.href = `${ASSETS}/mathlive/${file}`
          document.head.appendChild(link)
        }
      }
      await loadScript(`${ASSETS}/mathlive/mathlive.min.js`)
      const Element = window.MathfieldElement
      if (typeof Element !== 'function') throw new Error('MathLive did not define MathfieldElement')
      Element.fontsDirectory = null
      Element.soundsDirectory = null
      Element.defaultVirtualKeyboardMode = 'manual'
      return Element
    })()
    return pending
  }
})()

/**
 * MathLive parks its caret in `\placeholder{}` nodes. Those are editing
 * scaffolding, not part of the formula, so they never reach the LaTeX source.
 */
function stripPlaceholders(value) {
  return String(value ?? '').replace(/\\placeholder\{\}/gu, '')
}

/* ------------------------------------------------------------------ *
 * Clipboard
 * ------------------------------------------------------------------ */

/** Write plain text, falling back to the selection trick on a refused permission. */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const holder = document.createElement('textarea')
    holder.value = text
    holder.style.position = 'fixed'
    holder.style.left = '-9999px'
    document.body.appendChild(holder)
    holder.select()
    const ok = document.execCommand('copy')
    holder.remove()
    return ok
  }
}

/**
 * Write the Word equation payload.
 *
 * `text/html` carrying MathML is what Word turns into a native equation; `text/plain`
 * rides along so any other target still receives readable source. The async clipboard
 * is required because only it can put a non-text flavour on the clipboard.
 */
async function copyWordEquation(html, tex) {
  const item = new ClipboardItem({
    'text/html': new Blob([html], { type: 'text/html' }),
    'text/plain': new Blob([tex], { type: 'text/plain' }),
  })
  await navigator.clipboard.write([item])
}

/** Hand a byte array to the browser as a download. */
function downloadBytes(bytes, filename, mime) {
  const blob = new Blob([bytes], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  /* Revoking immediately can cancel the download in some builds; a tick is enough. */
  setTimeout(() => { URL.revokeObjectURL(url) }, 4000)
}

/* ------------------------------------------------------------------ *
 * The LaTeX wrappers
 * ------------------------------------------------------------------ */

/** The six plain-text wrappings of button A, in menu order. */
const LATEX_ACTIONS = [
  { id: 'plain', label: '无特殊附加', wrap: (tex) => tex },
  { id: 'dollar', label: '$ ... $ 格式', wrap: (tex) => `$ ${tex} $` },
  { id: 'double', label: '$$ ... $$ 格式', wrap: (tex) => `$$ ${tex} $$` },
  { id: 'bracket', label: '\\[ ... \\] 格式', wrap: (tex) => `\\[ ${tex} \\]` },
  { id: 'paren', label: '\\( ... \\) 格式', wrap: (tex) => `\\( ${tex} \\)` },
  {
    id: 'equation',
    label: '\\begin{equation} ... \\end{equation} 格式',
    wrap: (tex) => `\\begin{equation}\n${tex}\n\\end{equation}`,
  },
]

/* ------------------------------------------------------------------ *
 * The symbol palette
 * ------------------------------------------------------------------ */

/* SYMBOL_GROUPS, STYLE_ACTIONS and splitInsert come from src/symbols.js, which
 * the build inlines ahead of this file. Keeping the data there lets the Node
 * tests load it directly and prove every glyph is real LaTeX KaTeX accepts. */

/* ------------------------------------------------------------------ *
 * Styles
 * ------------------------------------------------------------------ */

const CSS = `
.dsffe-root { display:flex; flex-direction:column; gap:10px; height:100%; min-height:0;
  padding:12px; box-sizing:border-box; color:var(--dsw-alias-label-primary);
  font-size:13px; font-family:inherit; overflow:auto; }
.dsffe-drop { border:1px dashed var(--dsw-alias-border-l2); border-radius:8px;
  background:var(--dsw-alias-bg-layer-1); padding:14px 10px; text-align:center;
  color:var(--dsw-alias-label-secondary); cursor:pointer; transition:border-color .12s, background .12s;
  font-size:12px; line-height:1.6; }
.dsffe-drop:hover, .dsffe-drop.dsffe-over { border-color:var(--dsw-alias-brand-primary);
  background:var(--dsw-alias-bg-layer-2); }
.dsffe-drop strong { color:var(--dsw-alias-label-primary); font-weight:600; }
.dsffe-thumb { display:flex; align-items:center; gap:10px; }
.dsffe-thumb img { max-height:64px; max-width:100%; border-radius:6px;
  border:1px solid var(--dsw-alias-border-l1); background:#fff; }
.dsffe-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.dsffe-grow { flex:1 1 auto; }
.dsffe-label { font-size:12px; font-weight:600; color:var(--dsw-alias-label-secondary);
  display:flex; align-items:center; justify-content:space-between; gap:8px; }
.dsffe-input { width:100%; box-sizing:border-box; min-height:96px; resize:vertical;
  padding:8px 10px; border-radius:8px; border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary);
  font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:12.5px;
  line-height:1.55; outline:none; }
.dsffe-input:focus { border-color:var(--dsw-alias-brand-primary); }
.dsffe-preview { position:relative; min-height:56px; padding:12px; border-radius:8px;
  overflow-x:auto; background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dsw-alias-border-l1);
  display:flex; align-items:center; justify-content:center; cursor:text; }
.dsffe-preview:hover { border-color:var(--dsw-alias-border-l2); }
.dsffe-preview:focus-within { border-color:var(--dsw-alias-brand-primary); }
/* The editable formula surface. MathLive is a custom element with its own
   shadow DOM, so it is styled through the host and its ::part hooks only. */
.dsffe-mathfield { display:block; width:100%; min-height:32px; border:none;
  outline:none; padding:0; background:transparent; color:var(--dsw-alias-label-primary);
  font-size:1.15em; }
.dsffe-mathfield::part(virtual-keyboard-toggle) { display:none; }
.dsffe-mathfield::part(menu-toggle) { display:none; }
/* A display-mode formula reads centred, matching the source box's own layout. */
.dsffe-mathfield::part(content) { justify-content:center; }
.dsffe-preview-empty { position:absolute; inset:0; display:flex; align-items:center;
  justify-content:center; color:var(--dsw-alias-label-secondary); font-size:12px;
  pointer-events:none; }
.dsffe-empty { color:var(--dsw-alias-label-secondary); font-size:12px; }
.dsffe-err { color:var(--dsw-alias-state-error-primary); font-size:12px; white-space:pre-wrap;
  word-break:break-word; }
.dsffe-status { font-size:12px; color:var(--dsw-alias-label-secondary); min-height:16px; }
.dsffe-status.dsffe-good { color:var(--dsw-alias-state-success-primary); }
.dsffe-status.dsffe-bad { color:var(--dsw-alias-state-error-primary); }
.dsffe-btn { display:inline-flex; align-items:center; gap:6px; padding:6px 12px;
  border-radius:8px; border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary);
  font-size:12.5px; font-family:inherit; cursor:pointer; white-space:nowrap; }
.dsffe-btn:hover:not(:disabled) { border-color:var(--dsw-alias-brand-primary); }
.dsffe-btn:disabled { opacity:.55; cursor:default; }
.dsffe-btn.dsffe-primary { background:var(--dsw-alias-brand-primary); border-color:transparent;
  color:#fff; }
.dsffe-btn.dsffe-primary:hover:not(:disabled) { filter:brightness(1.06); }
.dsffe-split { position:relative; display:inline-flex; }
.dsffe-split > .dsffe-main { border-top-right-radius:0; border-bottom-right-radius:0; }
.dsffe-split > .dsffe-caret { border-top-left-radius:0; border-bottom-left-radius:0;
  border-left:none; padding:6px 7px; }
.dsffe-menu { position:absolute; z-index:40; top:calc(100% + 4px); left:0; min-width:max-content;
  background:var(--dsw-alias-bg-overlay); border:1px solid var(--dsw-alias-border-l2);
  border-radius:8px; padding:4px; box-shadow:0 8px 24px rgba(0,0,0,.28);
  display:flex; flex-direction:column; gap:2px; max-width:min(340px, 78vw); }
.dsffe-menu.dsffe-right { left:auto; right:0; }
.dsffe-item { text-align:left; padding:6px 10px; border:none; border-radius:6px;
  background:transparent; color:var(--dsw-alias-label-primary); font-size:12.5px;
  font-family:inherit; cursor:pointer; white-space:nowrap; }
.dsffe-item:hover { background:var(--dsw-alias-bg-layer-2); }
.dsffe-hint { font-size:11.5px; color:var(--dsw-alias-label-secondary); line-height:1.5; }
.dsffe-settings { display:flex; flex-direction:column; gap:10px; padding:4px 0; font-size:13px;
  color:var(--dsw-alias-label-primary); }
.dsffe-settings input[type=password], .dsffe-settings input[type=text] { width:100%;
  box-sizing:border-box; padding:6px 9px; border-radius:7px;
  border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary); font-family:ui-monospace, Menlo, Consolas, monospace;
  font-size:12px; outline:none; }
.dsffe-settings input:focus { border-color:var(--dsw-alias-brand-primary); }
.dsffe-page { height:100%; min-height:0; overflow:auto; box-sizing:border-box;
  padding:28px 24px; display:flex; justify-content:center; align-items:flex-start;
  background:var(--dsw-alias-bg-base); }
.dsffe-sheet { width:100%; max-width:1240px; display:flex; flex-direction:column; gap:16px; }
.dsffe-pagehead { display:flex; flex-direction:column; gap:6px; }
.dsffe-title { margin:0; font-size:20px; font-weight:600; line-height:1.3;
  color:var(--dsw-alias-label-primary); }
.dsffe-subtitle { margin:0; font-size:13px; line-height:1.6;
  color:var(--dsw-alias-label-secondary); }
.dsffe-page > .dsffe-sheet > .dsffe-root { height:auto; overflow:visible; padding:16px;
  border:1px solid var(--dsw-alias-border-l1); border-radius:12px;
  background:var(--dsw-alias-bg-layer-1); }
.dsffe-glyph { display:block; flex:none; }
/* The symbol palette: one box per category, each unfolding its own gallery.
   A max-content min-width keeps a box from ever clipping its label, and the
   slack goes into the boxes instead of the gaps, so every gap in the row is
   identical. 10px matches the gap the editor column already puts between the
   palette and the tools row below, so the spacing reads the same on both axes.
   Stretching the gaps (justify-content:space-between) or letting the boxes
   keep uneven widths (a 1fr grid) is what made the spacing lopsided before.
   Never use a backtick inside this template string. */
.dsffe-palette { --dsffe-gap:10px; display:flex; flex-direction:column;
  gap:var(--dsffe-gap); }
.dsffe-palette-row { display:flex; flex-wrap:wrap; gap:var(--dsffe-gap); }
.dsffe-cat-wrap { display:flex; flex:1 1 auto; min-width:max-content; }
.dsffe-cat { position:relative; display:flex; flex:1 1 auto; flex-direction:column;
  align-items:center; justify-content:center; gap:2px; padding:6px 6px 4px;
  border-radius:8px; box-sizing:border-box; width:100%;
  border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary); font-family:inherit; cursor:pointer; min-width:0; }
.dsffe-cat:hover { border-color:var(--dsw-alias-brand-primary);
  background:var(--dsw-alias-bg-layer-2); }
.dsffe-cat.dsffe-open { border-color:var(--dsw-alias-brand-primary);
  background:var(--dsw-alias-bg-layer-2); }
.dsffe-cat-glyph { display:flex; align-items:center; justify-content:center; min-height:22px;
  font-size:12px; line-height:1; max-width:100%; overflow:hidden; }
.dsffe-cat-glyph .katex { font-size:1.02em; }
.dsffe-cat-label { display:flex; align-items:center; gap:3px; max-width:100%;
  font-size:12.5px; line-height:1.4; color:var(--dsw-alias-label-secondary); }
.dsffe-cat-label > span:first-child { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsffe-cat-caret { font-size:10px; line-height:1; flex:0 0 auto; }
.dsffe-cat-menu { position:absolute; z-index:60; top:calc(100% + 4px); left:0;
  display:flex; flex-wrap:wrap; gap:3px; width:300px;
  max-height:340px; overflow:auto; padding:8px; background:var(--dsw-alias-bg-overlay);
  border:1px solid var(--dsw-alias-border-l2); border-radius:8px;
  box-shadow:0 8px 24px rgba(0,0,0,.28); }
.dsffe-cat-menu.dsffe-right { left:auto; right:0; }
.dsffe-sym { display:flex; align-items:center; justify-content:center; min-width:40px;
  height:40px; padding:0 6px; border:none; border-radius:6px; background:transparent;
  color:var(--dsw-alias-label-primary); font-family:inherit; font-size:16px; cursor:pointer; }
.dsffe-sym:hover { background:var(--dsw-alias-bg-layer-2); }
.dsffe-sym .katex { font-size:1.18em; }
.dsffe-sym.dsffe-broken { color:var(--dsw-alias-state-error-primary); font-size:12px; }
/* The editing tools under the palette, and the two copy buttons beside them. */
.dsffe-tools { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.dsffe-tool { display:inline-flex; align-items:center; gap:5px; padding:5px 9px;
  border-radius:7px; border:1px solid var(--dsw-alias-border-l1); background:transparent;
  color:var(--dsw-alias-label-primary); font-size:12px; font-family:inherit; cursor:pointer;
  white-space:nowrap; }
.dsffe-tool:hover:not(:disabled) { border-color:var(--dsw-alias-brand-primary);
  background:var(--dsw-alias-bg-layer-2); }
.dsffe-tool:disabled { opacity:.45; cursor:default; }
.dsffe-tool.dsffe-open { border-color:var(--dsw-alias-brand-primary);
  background:var(--dsw-alias-bg-layer-2); }
.dsffe-tool-split { position:relative; display:inline-flex; }
.dsffe-tool-menu { position:absolute; z-index:60; top:calc(100% + 4px); left:0;
  display:flex; flex-direction:column; gap:2px; min-width:max-content; padding:4px;
  background:var(--dsw-alias-bg-overlay); border:1px solid var(--dsw-alias-border-l2);
  border-radius:8px; box-shadow:0 8px 24px rgba(0,0,0,.28); max-height:280px; overflow:auto; }
`

/* ------------------------------------------------------------------ *
 * React
 * ------------------------------------------------------------------ */

const h = React.createElement

/** One split button: a primary action plus a caret that opens its menu. */
function SplitButton(props) {
  const { label, items, disabled, onPick, align, icon } = props
  const [open, setOpen] = React.useState(false)
  const holder = React.useRef(null)

  React.useEffect(() => {
    if (!open) return undefined
    const away = (event) => {
      if (holder.current !== null && !holder.current.contains(event.target)) setOpen(false)
    }
    const escape = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  const choose = (item) => {
    setOpen(false)
    onPick(item)
  }

  return h('div', { className: 'dsffe-split', ref: holder },
    h('button', {
      type: 'button',
      className: 'dsffe-btn dsffe-primary dsffe-main',
      disabled: disabled === true,
      onClick: () => { choose(items[0]) },
      title: label,
    }, icon === undefined ? null : h(Icon, { path: icon }), label),
    h('button', {
      type: 'button',
      className: 'dsffe-btn dsffe-primary dsffe-caret',
      disabled: disabled === true,
      'aria-haspopup': 'menu',
      'aria-expanded': open,
      onClick: () => { setOpen((was) => !was) },
      title: `${label} — 更多格式`,
    }, '\u25BE'),
    open
      ? h('div', { className: `dsffe-menu${align === 'right' ? ' dsffe-right' : ''}`, role: 'menu' },
          items.map((item) => h('button', {
            key: item.id,
            type: 'button',
            role: 'menuitem',
            className: 'dsffe-item',
            onClick: () => { choose(item) },
          }, item.label)))
      : null,
  )
}

/** One LaTeX snippet drawn by KaTeX; falls back to the source when it refuses. */
function KatexGlyph(props) {
  const { tex, ready } = props
  const host = React.useRef(null)
  const [failed, setFailed] = React.useState(false)

  React.useEffect(() => {
    if (ready !== true || host.current === null) return
    try {
      window.katex.render(tex, host.current, {
        displayMode: false,
        throwOnError: true,
        strict: 'ignore',
        trust: false,
      })
      setFailed(false)
    } catch {
      host.current.textContent = ''
      setFailed(true)
    }
  }, [tex, ready])

  if (ready !== true) return h('span', null, tex)
  if (failed) return h('span', { className: 'dsffe-sym dsffe-broken' }, tex)
  return h('span', { ref: host })
}

/** A category box: its sample glyph above its label, plus the gallery it unfolds. */
function SymbolCategory(props) {
  const { group, ready, onInsert } = props
  const [open, setOpen] = React.useState(false)
  const [align, setAlign] = React.useState('left')
  const holder = React.useRef(null)

  /* The last columns sit near the window edge, so the gallery opens leftwards. */
  const toggle = () => {
    if (!open && holder.current !== null) {
      const box = holder.current.getBoundingClientRect()
      setAlign(box.left + MENU_WIDTH > window.innerWidth - EDGE_GAP ? 'right' : 'left')
    }
    setOpen((was) => !was)
  }

  React.useEffect(() => {
    if (!open) return undefined
    const away = (event) => {
      if (holder.current !== null && !holder.current.contains(event.target)) setOpen(false)
    }
    const escape = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  const choose = (item) => {
    setOpen(false)
    onInsert(item)
  }

  return h('div', { className: 'dsffe-cat-wrap', ref: holder, style: { position: 'relative' } },
    h('button', {
      type: 'button',
      className: `dsffe-cat${open ? ' dsffe-open' : ''}`,
      'data-group': group.id,
      'aria-haspopup': 'menu',
      'aria-expanded': open,
      title: `${group.label} — 展开同类符号`,
      onClick: toggle,
    },
      h('span', { className: 'dsffe-cat-glyph' }, h(KatexGlyph, { tex: group.sample, ready })),
      h('span', { className: 'dsffe-cat-label' },
        h('span', null, group.label),
        h('span', { className: 'dsffe-cat-caret' }, '\u25BE'))),
    open
      ? h('div', {
        className: `dsffe-cat-menu${align === 'right' ? ' dsffe-right' : ''}`,
        role: 'menu',
        'data-menu': group.id,
      },
          group.items.map((item, index) => h('button', {
            key: `${group.id}-${index}`,
            type: 'button',
            role: 'menuitem',
            className: 'dsffe-sym',
            title: item.i ?? item.g,
            onClick: () => { choose(item) },
          }, h(KatexGlyph, { tex: item.g, ready }))))
      : null,
  )
}

/** The eleven category boxes, in the order the toolbar shows them. */
function SymbolPalette(props) {
  const { ready, onInsert } = props
  return h('div', { className: 'dsffe-palette' },
    h('div', { className: 'dsffe-palette-row' },
      FormulaSymbols.SYMBOL_GROUPS.map((group) => h(SymbolCategory, {
        key: group.id,
        group,
        ready,
        onInsert,
      }))))
}

/** The T button: wraps the selection in one of the math styles. */
function StyleButton(props) {
  const { disabled, onPick } = props
  const [open, setOpen] = React.useState(false)
  const holder = React.useRef(null)

  React.useEffect(() => {
    if (!open) return undefined
    const away = (event) => {
      if (holder.current !== null && !holder.current.contains(event.target)) setOpen(false)
    }
    const escape = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  return h('div', { className: 'dsffe-tool-split', ref: holder },
    h('button', {
      type: 'button',
      className: `dsffe-tool${open ? ' dsffe-open' : ''}`,
      disabled: disabled === true,
      'aria-haspopup': 'menu',
      'aria-expanded': open,
      title: '数学样式',
      onClick: () => { setOpen((was) => !was) },
    }, h('span', { style: { fontStyle: 'italic', fontWeight: 600 } }, 'T'),
       h('span', { style: { fontSize: '7px' } }, '\u25BE')),
    open
      ? h('div', { className: 'dsffe-tool-menu', role: 'menu' },
          FormulaSymbols.STYLE_ACTIONS.map((action) => h('button', {
            key: action.id,
            type: 'button',
            role: 'menuitem',
            className: 'dsffe-item',
            onClick: () => { setOpen(false); onPick(action) },
          }, action.label)))
      : null,
  )
}

/** A tiny inline icon; `path` is the SVG body. */
function Icon(props) {
  const { path, size } = props
  const box = size ?? 13
  return h('svg', {
    width: box,
    height: box,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
    style: { flex: '0 0 auto' },
    dangerouslySetInnerHTML: { __html: path },
  })
}

/* The tool row's icons, drawn to read at 13px. */
const ICON_TRASH = '<path d="M2.5 4h11"/><path d="M6.5 4V2.6h3V4"/><path d="M4 4l.6 9.2h6.8L12 4"/><path d="M6.6 6.6v4.4M9.4 6.6v4.4"/>'
const ICON_UNDO = '<path d="M3 7.5h6.2a3.3 3.3 0 0 1 0 6.6H6.4"/><path d="M5.6 4.2 2.6 7.5l3 3.1"/>'
const ICON_REDO = '<path d="M13 7.5H6.8a3.3 3.3 0 0 0 0 6.6h2.8"/><path d="M10.4 4.2l3 3.3-3 3.1"/>'
const ICON_NEWLINE = '<path d="M3 3.4v4.9a2.1 2.1 0 0 0 2.1 2.1H12"/><path d="M9.6 7.6 12.4 10.4 9.6 13.2"/>'
const ICON_COPY = '<rect x="5.2" y="5.2" width="8" height="8" rx="1.4"/><path d="M10.6 5.2V3.6a1.4 1.4 0 0 0-1.4-1.4H3.6a1.4 1.4 0 0 0-1.4 1.4v5.6a1.4 1.4 0 0 0 1.4 1.4h1.6"/>'
const ICON_FORMULA = '<path d="M3 12.6c1.2 0 1.6-.7 2.1-2.2l2-6c.5-1.5.9-2.2 2.1-2.2"/><path d="M3.4 6.4h5.4"/><path d="M10.4 9.4h3.2M12 7.8v3.2"/>'

/** The editor tab. */
function FormulaEditor(props) {
  const { visible } = props
  const [tex, setTex] = React.useState('')
  const [image, setImage] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [status, setStatus] = React.useState('')
  const [statusKind, setStatusKind] = React.useState('')
  const [error, setError] = React.useState('')
  const [ready, setReady] = React.useState(false)
  const [fieldReady, setFieldReady] = React.useState(false)
  const [over, setOver] = React.useState(false)
  const field = React.useRef(null)
  const fileInput = React.useRef(null)
  const lastImage = React.useRef(null)
  const area = React.useRef(null)
  /* Which surface the user last edited in: the source box or the formula
   * itself. Palette snippets go wherever the caret visibly was. */
  const surface = React.useRef('area')
  /* The undo/redo stacks are refs, not state: they only ever move together with
   * `tex`, and pushing to them must not schedule an extra render. The counter
   * exists only to re-render the toolbar when a stack changes size. */
  const history = React.useRef({ past: [], future: [] })
  const [, bumpHistory] = React.useState(0)
  /* The source the field was last known to show. Comparing against it keeps the
   * source -> field effect from rewriting the field after an edit made in the
   * field itself, which would send the caret to the end on every keystroke. */
  const synced = React.useRef('')
  /* The same value for listeners registered once, outside the render scope. */
  const texRef = React.useRef('')
  texRef.current = tex

  React.useEffect(() => {
    let alive = true
    katexReady().then(() => { if (alive) setReady(true) }, (problem) => {
      if (alive) setError(`预览组件加载失败：${problem.message}`)
    })
    return () => { alive = false }
  }, [])

  /* The editable formula surface. MathLive is loaded once for the whole page;
   * the field only mounts after it is defined so the element upgrades. */
  React.useEffect(() => {
    let alive = true
    mathliveReady().then(() => { if (alive) setFieldReady(true) }, (problem) => {
      if (alive) setError(`公式编辑组件加载失败：${problem.message}`)
    })
    return () => { alive = false }
  }, [])

  /* Source -> field. Skipped when the two already agree, which is the case for
   * every edit made inside the field: rewriting the value there would move the
   * caret to the end after each keystroke. */
  React.useEffect(() => {
    const node = field.current
    if (!fieldReady || node === null) return
    if (synced.current === tex) return
    synced.current = tex
    node.value = tex
  }, [tex, fieldReady])

  /* Field -> source. MathLive dispatches `input` on the host for every edit it
   * accepts, so one listener covers typing, palette insertion and deletion.
   * Both listeners are attached by hand rather than through React props:
   * MathLive is a custom element, and React would forward them as attributes. */
  React.useEffect(() => {
    const node = field.current
    if (!fieldReady || node === null) return undefined
    /* React 18 hands an unknown element its props verbatim, so className would
       land as a `classname` attribute. Set the class on the node instead. */
    node.className = 'dsffe-mathfield'
    const onInput = () => { surface.current = 'field'; syncFromField() }
    const onFocus = () => { surface.current = 'field' }
    node.addEventListener('input', onInput)
    node.addEventListener('focus', onFocus)
    return () => {
      node.removeEventListener('input', onInput)
      node.removeEventListener('focus', onFocus)
    }
  }, [fieldReady])

  /* MathLive keeps focus inside its shadow tree, and a click on a palette button
   * moves focus out before the snippet is inserted. Watching `focusin` at the
   * document level keeps `surface` correct across that detour, so a snippet
   * picked while editing the formula still lands in the formula. */
  React.useEffect(() => {
    const onFocusIn = (event) => {
      const node = field.current
      if (node === null) return
      const target = event.target
      if (target === node || (typeof target?.closest === 'function' && target.closest('math-field') !== null)) {
        surface.current = 'field'
      } else if (target === area.current) {
        surface.current = 'area'
      }
    }
    document.addEventListener('focusin', onFocusIn)
    return () => { document.removeEventListener('focusin', onFocusIn) }
  }, [])

  const say = (message, kind) => {
    setStatus(message)
    setStatusKind(kind ?? '')
  }

  /* ---------------------------------------------------------------- *
   * Editing the source box
   * ---------------------------------------------------------------- */

  /**
   * The last selection seen in the textarea.
   *
   * Clicking a palette button takes focus off the textarea, and a blurred
   * textarea keeps reporting a stale (or zero) selection in some engines. We
   * record it while the box still has focus so the insert lands where the
   * caret visibly was.
   */
  const caretMark = React.useRef({ start: 0, end: 0 })

  const rememberCaret = () => {
    const node = area.current
    if (node === null) return
    caretMark.current = {
      start: node.selectionStart ?? 0,
      end: node.selectionEnd ?? 0,
    }
  }

  /* Track the selection even when the browser reports it outside our handlers:
     a palette click blurs the box first, and the caret must not be lost then. */
  React.useEffect(() => {
    const onSelectionChange = () => {
      if (document.activeElement === area.current) rememberCaret()
    }
    document.addEventListener('selectionchange', onSelectionChange)
    return () => { document.removeEventListener('selectionchange', onSelectionChange) }
  }, [])

  /** The selection to act on: the live one when focused, else the remembered one. */
  const currentSelection = () => {
    const node = area.current
    if (node !== null && document.activeElement === node) {
      return { start: node.selectionStart ?? 0, end: node.selectionEnd ?? 0 }
    }
    return caretMark.current
  }

  /** Replace the whole source, remembering the old value for undo. */
  const commit = (next) => {
    const before = tex
    if (next === before) return
    history.current.past.push(before)
    if (history.current.past.length > 200) history.current.past.shift()
    history.current.future = []
    setTex(next)
    bumpHistory((was) => was + 1)
  }

  /**
   * Put the caret at `caret` in the textarea, focusing it first.
   *
   * The offset is parked in a ref and applied by the layout effect below, which
   * runs after React has written the new `value`. Setting it here would be
   * clamped against the old, shorter string and silently land at its end.
   */
  const pendingCaret = React.useRef(null)

  React.useLayoutEffect(() => {
    const at = pendingCaret.current
    if (at === null) return
    pendingCaret.current = null
    const node = area.current
    if (node === null) return
    const clamped = Math.max(0, Math.min(at, node.value.length))
    node.focus()
    node.setSelectionRange(clamped, clamped)
    caretMark.current = { start: clamped, end: clamped }
  })

  const placeCaret = (caret, length) => {
    const at = Math.max(0, Math.min(caret, length))
    caretMark.current = { start: at, end: at }
    pendingCaret.current = at
  }

  /* ---------------------------------------------------------------- *
   * Editing the formula itself (the editable preview)
   * ---------------------------------------------------------------- */

  /** Pull the field's source into React state, keeping undo history. */
  const syncFromField = () => {
    const node = field.current
    if (node === null) return
    const next = stripPlaceholders(node.value)
    const before = texRef.current
    synced.current = next
    if (next === before) return
    history.current.past.push(before)
    if (history.current.past.length > 200) history.current.past.shift()
    history.current.future = []
    setTex(next)
    bumpHistory((was) => was + 1)
  }

  /**
   * Write into the field at its own caret.
   *
   * `#@` is MathLive's placeholder marker: it both lands the caret there and
   * leaves a visible slot, so a template inserted from the palette behaves like
   * the same template in Word. The markers never reach the LaTeX source.
   */
  const insertIntoField = (snippet) => {
    const node = field.current
    if (node === null) return
    node.focus()
    node.insert(snippet)
    syncFromField()
  }

  /**
   * Insert a palette snippet where the caret was.
   *
   * The surface decides the destination: whichever of the two boxes the user
   * last put the caret in receives the snippet, so the palette works from
   * either one without a mode switch.
   */
  const insertAtSelection = (item) => {
    if (surface.current === 'field') {
      const raw = FormulaSymbols.rawInsert(item)
      insertIntoField(raw.replace(/\|/gu, '#@'))
      return
    }
    const { body, caret } = FormulaSymbols.splitInsert(item)
    const { start, end } = currentSelection()
    const from = Math.max(0, Math.min(start, tex.length))
    const to = Math.max(from, Math.min(end, tex.length))
    const next = tex.slice(0, from) + body + tex.slice(to)
    commit(next)
    placeCaret(from + caret, next.length)
  }

  /** Wrap the selection in a style command, or drop an empty pair at the caret. */
  const applyStyle = (action) => {
    if (surface.current === 'field') {
      const node = field.current
      if (node === null) return
      node.focus()
      const chosen = node.getValue(node.selection, 'latex')
      node.insert(`${action.open}${chosen.length > 0 ? chosen : '#@'}${action.close}`)
      syncFromField()
      return
    }
    const { start, end } = currentSelection()
    const from = Math.max(0, Math.min(start, tex.length))
    const to = Math.max(from, Math.min(end, tex.length))
    const chosen = tex.slice(from, to)
    const next = tex.slice(0, from) + action.open + chosen + action.close + tex.slice(to)
    commit(next)
    placeCaret(from + action.open.length + chosen.length, next.length)
  }

  const undo = () => {
    const stack = history.current
    if (stack.past.length === 0) return
    const previous = stack.past.pop()
    stack.future.push(tex)
    setTex(previous)
    bumpHistory((was) => was + 1)
    if (surface.current === 'field') {
      if (field.current !== null) field.current.value = previous
      return
    }
    placeCaret(previous.length, previous.length)
  }

  const redo = () => {
    const stack = history.current
    if (stack.future.length === 0) return
    const next = stack.future.pop()
    stack.past.push(tex)
    setTex(next)
    bumpHistory((was) => was + 1)
    if (surface.current === 'field') {
      if (field.current !== null) field.current.value = next
      return
    }
    placeCaret(next.length, next.length)
  }

  /** Break the line at the caret: a newline in the source, `\\` in the formula. */
  const newline = () => {
    if (surface.current === 'field') {
      insertIntoField('\\\\')
      return
    }
    const { start, end } = currentSelection()
    const from = Math.max(0, Math.min(start, tex.length))
    const to = Math.max(from, Math.min(end, tex.length))
    const next = `${tex.slice(0, from)}\n${tex.slice(to)}`
    commit(next)
    placeCaret(from + 1, next.length)
  }

  /** Read a picked or dropped file into a data URL and show it. */
  const acceptFile = (file) => {
    if (file === null || file === undefined) return
    if (!/^image\//u.test(file.type)) {
      say('请选择图片文件', 'bad')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result ?? '')
      setImage(dataUrl)
      lastImage.current = dataUrl
      setError('')
      say('图片已就绪，正在识别…')
      void recognize(dataUrl)
    }
    reader.onerror = () => { say('图片读取失败', 'bad') }
    reader.readAsDataURL(file)
  }

  /** POST the image to the host half and put the answer in the source box. */
  const recognize = async (dataUrl) => {
    const source = dataUrl ?? lastImage.current
    if (source === null || source === undefined) {
      say('请先拖入、粘贴或选择一张公式图片', 'bad')
      return
    }
    setBusy(true)
    setError('')
    say('识别中…')
    try {
      const response = await fetch(ROUTE_OCR, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image: source }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        const detail = typeof payload.detail === 'string' ? payload.detail : ''
        if (payload.error === 'api-key-missing') {
          throw new Error('尚未配置 OCR API Key：请在「设置 → 侧边卡片 → 公式编辑器」里填写。')
        }
        if (payload.error === 'endpoint-missing') {
          throw new Error('尚未配置视觉模型接口：请在 profile 的 cordis.patch.yml 里给本插件设置 baseURL 和 model。')
        }
        throw new Error(detail.length > 0 ? detail : `识别失败（HTTP ${response.status}）`)
      }
      const latex = typeof payload.latex === 'string' ? payload.latex : ''
      if (payload.empty === true || latex.length === 0) {
        say('没有在图片中识别到公式', 'bad')
        return
      }
      surface.current = 'area'
      commit(latex)
      say('识别完成，已填入输入框', 'good')
    } catch (problem) {
      const message = problem instanceof Error ? problem.message : String(problem)
      setError(message)
      say('识别失败', 'bad')
    } finally {
      setBusy(false)
    }
  }

  /* Ctrl+V anywhere in the tab drops an image into the recognizer. */
  React.useEffect(() => {
    if (visible === false) return undefined
    const onPaste = (event) => {
      const items = event.clipboardData?.items
      if (items === undefined) return
      for (const item of items) {
        if (item.kind === 'file' && /^image\//u.test(item.type)) {
          const file = item.getAsFile()
          if (file !== null) {
            event.preventDefault()
            acceptFile(file)
            return
          }
        }
      }
    }
    document.addEventListener('paste', onPaste)
    return () => { document.removeEventListener('paste', onPaste) }
  }, [visible])

  const requireTex = () => {
    const text = tex.trim()
    if (text.length === 0) {
      say('请先输入或识别公式', 'bad')
      return null
    }
    return text
  }

  const pickLatex = async (item) => {
    const text = requireTex()
    if (text === null) return
    try {
      const ok = await copyText(item.wrap(text))
      say(ok ? `已复制（${item.label}）` : '复制被浏览器拒绝', ok ? 'good' : 'bad')
    } catch (problem) {
      say(`复制失败：${problem.message}`, 'bad')
    }
  }

  const pickWord = async (item) => {
    const text = requireTex()
    if (text === null) return
    setError('')
    try {
      if (item.id === 'word') {
        const vendor = await convertReady()
        const html = FormulaConvert.buildWordHtml(vendor.temml, text)
        await copyWordEquation(html, text)
        say('已复制 Word 公式，粘贴到 Word 即为可编辑公式', 'good')
        return
      }
      if (item.id === 'asciimath') {
        const ok = await copyText(FormulaConvert.toAsciimath(text))
        say(ok ? '已复制 AsciiMath' : '复制被浏览器拒绝', ok ? 'good' : 'bad')
        return
      }
      if (item.id === 'typst') {
        const vendor = await convertReady()
        if (typeof vendor.tex2typst !== 'function') throw new Error('Typst 转换器不可用')
        const typst = vendor.tex2typst(text)
        if (typeof typst !== 'string' || typst.length === 0) throw new Error('无法转换为 Typst')
        const ok = await copyText(typst)
        say(ok ? '已复制 Typst' : '复制被浏览器拒绝', ok ? 'good' : 'bad')
        return
      }
      if (item.id === 'docx') {
        const vendor = await convertReady()
        const omml = FormulaConvert.toOmml(vendor.temml, vendor.mml2omml, text)
        const bytes = FormulaConvert.buildDocxBytes(omml)
        downloadBytes(
          bytes,
          'formula.docx',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        )
        say('已导出 formula.docx', 'good')
      }
    } catch (problem) {
      setError(`转换失败：${problem.message}`)
      say('操作失败', 'bad')
    }
  }

  const wordItems = [
    { id: 'word', label: '复制MathML(Word)' },
    { id: 'asciimath', label: '复制AsciiMath' },
    { id: 'typst', label: '复制Typst' },
    { id: 'docx', label: '导出Docx(Word/WPS)' },
  ]

  return h('div', {
    className: 'dsffe-root',
    onDragOver: (event) => { event.preventDefault(); setOver(true) },
    onDragLeave: () => { setOver(false) },
    onDrop: (event) => {
      event.preventDefault()
      setOver(false)
      const file = event.dataTransfer?.files?.[0]
      acceptFile(file)
    },
  },
    h('div', {
      className: `dsffe-drop${over ? ' dsffe-over' : ''}`,
      onClick: () => { fileInput.current?.click() },
      role: 'button',
      tabIndex: 0,
      onKeyDown: (event) => {
        if (event.key === 'Enter' || event.key === ' ') fileInput.current?.click()
      },
    },
      image === null
        ? h('span', null,
            h('strong', null, '拖拽图片到此处'),
            '，或点击选择文件；也可直接 ',
            h('strong', null, 'Ctrl+V'),
            ' 粘贴截图')
        : h('div', { className: 'dsffe-thumb' },
            h('img', { src: image, alt: '待识别的公式图片' }),
            h('div', { className: 'dsffe-hint' }, '点击或拖入可更换图片'))),
    h('input', {
      type: 'file',
      accept: 'image/*',
      ref: fileInput,
      style: { display: 'none' },
      onChange: (event) => {
        acceptFile(event.target.files?.[0])
        event.target.value = ''
      },
    }),
    h('div', { className: 'dsffe-row' },
      h('button', {
        type: 'button',
        className: 'dsffe-btn',
        disabled: busy,
        onClick: () => { void recognize(null) },
      }, busy ? '识别中…' : '重新识别'),
      h('span', { className: 'dsffe-grow' }),
      /* The row keeps a slot on the right only while the formula surface is
       * still loading; once it is ready the space stays empty on purpose, so
       * the row is the button alone and nothing claims the formula is editable. */
      ready && fieldReady ? null : h('span', { className: 'dsffe-hint' }, '加载公式组件…')),

    h('div', { className: 'dsffe-label' }, h('span', null, 'LaTeX 源码')),
    h('textarea', {
      className: 'dsffe-input',
      ref: area,
      value: tex,
      spellCheck: false,
      placeholder: '在此输入或粘贴 LaTeX，例如 \\frac{a+b}{c-d}',
      onChange: (event) => {
        surface.current = 'area'
        rememberCaret()
        commit(event.target.value)
      },
      onSelect: () => { surface.current = 'area'; rememberCaret() },
      onKeyUp: () => { surface.current = 'area'; rememberCaret() },
      onClick: () => { surface.current = 'area'; rememberCaret() },
      onFocus: () => { surface.current = 'area' },
      onBlur: rememberCaret,
    }),

    /* The formula itself is editable: the same surface shows the result and
       accepts the next edit, and either direction updates the source above. */
    h('div', {
      className: `dsffe-preview${tex.trim().length === 0 ? '' : ' dsffe-filled'}`,
      'data-surface': 'formula',
      onMouseDown: () => { surface.current = 'field' },
    },
      h('math-field', {
        className: 'dsffe-mathfield',
        ref: field,
        'data-field': 'formula',
      }),
      tex.trim().length === 0
        ? h('div', { className: 'dsffe-preview-empty' }, '在这里直接编辑公式，源码会同步更新')
        : null),

    /* The Word-style palette: pick a symbol, or open a category for the rest. */
    h(SymbolPalette, { ready, onInsert: insertAtSelection }),

    /* Editing tools on the left, the two copy actions on the right. */
    h('div', { className: 'dsffe-tools' },
      h('button', {
        type: 'button',
        className: 'dsffe-tool',
        disabled: busy || (image === null && tex.length === 0),
        title: '清空',
        onClick: () => {
          commit('')
          setImage(null)
          lastImage.current = null
          setError('')
          say('已清空')
          if (field.current !== null) field.current.value = ''
        },
      }, h(Icon, { path: ICON_TRASH }), '清空'),
      h('button', {
        type: 'button',
        className: 'dsffe-tool',
        'data-tool': 'undo',
        disabled: history.current.past.length === 0,
        title: '撤销',
        onClick: undo,
      }, h(Icon, { path: ICON_UNDO }), '撤销'),
      h('button', {
        type: 'button',
        className: 'dsffe-tool',
        'data-tool': 'redo',
        disabled: history.current.future.length === 0,
        title: '重做',
        onClick: redo,
      }, h(Icon, { path: ICON_REDO }), '重做'),
      h('button', {
        type: 'button',
        className: 'dsffe-tool',
        'data-tool': 'newline',
        title: '换行',
        onClick: newline,
      }, h(Icon, { path: ICON_NEWLINE }), '换行'),
      h(StyleButton, { disabled: false, onPick: applyStyle }),
      h('span', { className: 'dsffe-grow' }),
      h(SplitButton, {
        label: '复制LaTeX',
        items: LATEX_ACTIONS,
        disabled: busy,
        icon: ICON_COPY,
        onPick: (item) => { void pickLatex(item) },
      }),
      h(SplitButton, {
        label: '复制MathML(Word)',
        items: wordItems,
        disabled: busy,
        icon: ICON_FORMULA,
        onPick: (item) => { void pickWord(item) },
      })),

    h('div', { className: `dsffe-status${statusKind === 'good' ? ' dsffe-good' : statusKind === 'bad' ? ' dsffe-bad' : ''}` }, status),
    error.length > 0 ? h('div', { className: 'dsffe-err' }, error) : null,
    h('div', { className: 'dsffe-hint' },
      '「复制MathML(Word)」写入的是 MathML 富文本，Word 粘贴时会自行转成原生公式，双击即可编辑；「导出Docx」生成的 .docx 里嵌入的是 OMML。'),
  )
}

/* The left navigation row's glyph. It is an outline SVG on the same 16-unit
 * grid the shipped icons use, drawn into exactly the box the row hands it —
 * the same contract those icons keep. A text glyph cannot hold that contract:
 * the sigma's ink is wider than an icon, so it pushed the row's label several
 * pixels left of every other row's label, and its line box was taller, so the
 * row grew and the column's vertical rhythm went off.
 *
 * The stroke is 1.3, the design system's own "medium" weight (the shipped
 * regular icons are 1, medium 1.3): a sigma is mostly one long thin polyline,
 * so at 1 it reads lighter than the boxier icons beside it. Staying on a
 * documented step keeps it looking deliberate rather than arbitrarily heavy.
 * Never use a backtick inside this file's template strings. */
/* The sigma spans about eleven units of the sixteen-unit grid, which is the
 * ink a shipped icon of the same box covers; narrower than that reads as a
 * smaller icon even though the box is identical. */
const SIGMA_PATH = 'M13.25 2.5H2.75L8 8l-5.25 5.5h10.5'
const SIGMA_STROKE = 1.3

function PanelGlyph(owner) {
  const size = (owner !== null && owner !== undefined && typeof owner.size === 'number') ? owner.size : 16
  return h('svg', {
    className: 'dsffe-glyph',
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: SIGMA_STROKE,
    strokeLinejoin: 'round',
    strokeLinecap: 'round',
    'aria-hidden': 'true',
    'data-glyph': 'sigma',
  }, h('path', { d: SIGMA_PATH }))
}

/** The main-area page the left navigation entry selects. */
function FormulaPage() {
  return h('div', { className: 'dsffe-page' },
    h('div', { className: 'dsffe-sheet' },
      h('div', { className: 'dsffe-pagehead' },
        h('h1', { className: 'dsffe-title' }, '公式编辑器'),
        h('p', { className: 'dsffe-subtitle' },
          '识别图片里的公式、直接编辑公式、复制成 Word 原生公式或导出 .docx。')),
      h(FormulaEditor, { visible: true })))
}

/** The API-key panel shown on the sidebar's settings page. */
function FormulaSettings(props) {
  const { pluginSettings, updatePluginSetting } = props
  const [info, setInfo] = React.useState(null)
  const [draft, setDraft] = React.useState('')
  const [status, setStatus] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const stored = typeof pluginSettings?.apiKeyDraft === 'string' ? pluginSettings.apiKeyDraft : ''

  const refresh = React.useCallback(async () => {
    try {
      const response = await fetch(ROUTE_SETTINGS)
      const payload = await response.json()
      setInfo(payload)
    } catch (problem) {
      setStatus(`读取设置失败：${problem.message}`)
    }
  }, [])

  React.useEffect(() => { void refresh() }, [refresh])
  React.useEffect(() => { if (stored.length > 0) setDraft(stored) }, [stored])

  const save = async () => {
    const value = draft.trim()
    if (value.length === 0) {
      setStatus('请先填入 API Key')
      return
    }
    setBusy(true)
    setStatus('')
    try {
      const response = await fetch(ROUTE_SETTINGS, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: value }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.detail ?? payload.error ?? `HTTP ${response.status}`)
      updatePluginSetting?.('apiKeyDraft', '')
      setDraft('')
      setStatus('已保存')
      await refresh()
    } catch (problem) {
      setStatus(`保存失败：${problem.message}`)
    } finally {
      setBusy(false)
    }
  }

  const clear = async () => {
    setBusy(true)
    setStatus('')
    try {
      const response = await fetch(ROUTE_SETTINGS, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clear: true }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      updatePluginSetting?.('apiKeyDraft', '')
      setDraft('')
      setStatus('已清除插件自己的 Key')
      await refresh()
    } catch (problem) {
      setStatus(`清除失败：${problem.message}`)
    } finally {
      setBusy(false)
    }
  }

  const configured = info?.configured === true
  const source = typeof info?.source === 'string' ? info.source : ''
  const usingRef = typeof info?.usingRef === 'string' ? info.usingRef : ''

  return h('div', { className: 'dsffe-settings' },
    h('div', { className: 'dsffe-hint' },
      '公式图片识别使用可配置的视觉大模型。Key 保存在本机凭据存储中，不会写进插件文件。'),
    h('div', null,
      h('div', { className: 'dsffe-label' }, h('span', null, 'OCR API Key')),
      h('input', {
        type: 'password',
        value: draft,
        placeholder: configured ? '已配置（留空则保持不变）' : 'sk-...',
        spellCheck: false,
        onChange: (event) => { setDraft(event.target.value) },
      })),
    h('div', { className: 'dsffe-row' },
      h('button', { type: 'button', className: 'dsffe-btn dsffe-primary', disabled: busy, onClick: () => { void save() } }, '保存'),
      h('button', { type: 'button', className: 'dsffe-btn', disabled: busy || info?.ownConfigured !== true, onClick: () => { void clear() } }, '清除')),
    h('div', { className: 'dsffe-hint' },
      configured
        ? `当前状态：已配置（来源 ${source}${usingRef.length > 0 ? `，${usingRef}` : ''}）`
        : '当前状态：未配置，图片识别会提示缺少 Key'),
    h('div', { className: 'dsffe-hint' },
      `接口：${info?.baseURL ? info.baseURL : '未设置'} · 模型：${info?.model ? info.model : '未设置'}`),
    status.length > 0 ? h('div', { className: 'dsffe-hint' }, status) : null,
  )
}

/* ------------------------------------------------------------------ *
 * Registration
 * ------------------------------------------------------------------ */

/** Mount the tab and the settings panel onto the sidebar service. */
function apply(ctx) {
  /* A plain <style> tag, removed with the plugin: installed Client modules get no
   * stylesheet seam, and this is what the other installed plugins do too. */
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-formula-editor'
    tag.textContent = CSS
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'dsh-formula-editor: styles')

  /* The left navigation entry: a global panel row beside Plugins and the task
   * board, and the main page it selects. The row's id is the main panel's key,
   * so the sidebar's own selected state tracks the page with no extra wiring. */
  let layout
  ctx.inject(['layout'], (scoped) => { layout = scoped.layout })
  ctx.slots.inject('sidebar.panellist', () => {
    const offRow = ctx.slots.register({
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: 40,
      label: () => '公式编辑器',
    }, PanelGlyph)
    const offPage = ctx.slots.register({
      name: 'main',
      key: PANEL_ID,
    }, FormulaPage)
    return () => {
      if (layout?.panelInfo.getSnapshot().activePanelId === PANEL_ID) layout.selectPanel(null)
      if (typeof offPage === 'function') offPage()
      if (typeof offRow === 'function') offRow()
    }
  })

  /* The right sidebar tab, kept alongside the left entry: same editor, and the
   * only place its settings panel is reachable from. */
  const service = ctx.get('betterSidebar')
  if (service === undefined || service === null) {
    console.error('[dsh-formula-editor] betterSidebar is unavailable; the tab was not registered')
    return
  }

  ctx.effect(() => service.registerTab({
    id: TAB_ID,
    title: () => '公式编辑器',
    description: () => '图片识别公式、可编辑公式域，复制为 Word 原生公式',
    order: 40,
    single: true,
    icon: h('span', { style: { fontSize: '15px', lineHeight: 1 }, 'aria-hidden': 'true' }, '\u2211'),
    component: (props) => h(FormulaEditor, props),
    settings: {
      render: (props) => h(FormulaSettings, props),
    },
  }), 'dsh-formula-editor: sidebar tab')
}

return {
  /* `slots` is the hard dependency: the left navigation entry is the primary
   * surface. The right sidebar tab is a bonus, so `betterSidebar` stays optional
   * and a profile without that plugin still gets a working editor. */
  inject: ['slots'],
  apply,
}
