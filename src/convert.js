/**
 * Pure conversion code for dsh-formula-editor.
 *
 * Nothing here touches the DOM, React or the network, so the same file is inlined
 * into the client bundle by scripts/build-client.mjs and exercised directly by
 * scripts/test-convert.mjs in Node. That split is what makes the OMML, AsciiMath
 * and .docx output verifiable without a browser.
 */

/* ------------------------------------------------------------------ *
 * XML
 * ------------------------------------------------------------------ */

/** Escape text for XML content and attribute values. */
function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Decode the five XML entities plus numeric character references. */
function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    switch (body) {
      case 'lt': return '<'
      case 'gt': return '>'
      case 'amp': return '&'
      case 'quot': return '"'
      case 'apos': return "'"
      case 'nbsp': return '\u00A0'
      default: return whole
    }
  })
}

/** Find the `>` that closes a start tag, skipping quoted attribute values. */
function findTagEnd(source, from) {
  let quote = ''
  for (let i = from + 1; i < source.length; i += 1) {
    const ch = source[i]
    if (quote !== '') {
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '>') return i
  }
  return source.length - 1
}

/** Split a start tag body into its name and attributes. */
function parseTag(body) {
  const nameMatch = /^[^\s/>]+/.exec(body)
  const name = nameMatch === null ? '' : nameMatch[0]
  const attrs = {}
  const pattern = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g
  let match
  while ((match = pattern.exec(body)) !== null) {
    attrs[match[1]] = decodeEntities(match[3] !== undefined ? match[3] : match[4])
  }
  return { name, attrs }
}

/**
 * Parse the well-formed XML a renderer emits into `{name, attrs, children}` nodes.
 * Text children carry `name === '#text'` and their `text`.
 */
function parseXml(source) {
  const root = { name: '#root', attrs: {}, children: [] }
  const stack = [root]
  const pushText = (raw) => {
    if (raw.length === 0) return
    stack[stack.length - 1].children.push({ name: '#text', text: decodeEntities(raw), children: [] })
  }
  let i = 0
  while (i < source.length) {
    const lt = source.indexOf('<', i)
    if (lt === -1) {
      pushText(source.slice(i))
      break
    }
    if (lt > i) pushText(source.slice(i, lt))
    if (source.startsWith('<?', lt)) {
      const end = source.indexOf('?>', lt)
      i = end === -1 ? source.length : end + 2
      continue
    }
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt)
      i = end === -1 ? source.length : end + 3
      continue
    }
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt)
      pushText(source.slice(lt + 9, end === -1 ? source.length : end))
      i = end === -1 ? source.length : end + 3
      continue
    }
    const end = findTagEnd(source, lt)
    if (source.startsWith('</', lt)) {
      if (stack.length > 1) stack.pop()
      i = end + 1
      continue
    }
    let body = source.slice(lt + 1, end)
    const selfClosing = body.endsWith('/')
    if (selfClosing) body = body.slice(0, -1)
    const { name, attrs } = parseTag(body)
    const node = { name, attrs, children: [] }
    stack[stack.length - 1].children.push(node)
    if (!selfClosing) stack.push(node)
    i = end + 1
  }
  return root
}

/** Serialize a parsed tree back to XML text. */
function serializeXml(node) {
  if (node.name === '#text') return escapeXml(node.text)
  const attrs = Object.keys(node.attrs)
    .map((key) => ` ${key}="${escapeXml(node.attrs[key])}"`)
    .join('')
  const inner = node.children.map(serializeXml).join('')
  if (inner.length === 0) return `<${node.name}${attrs}></${node.name}>`
  return `<${node.name}${attrs}>${inner}</${node.name}>`
}

/* ------------------------------------------------------------------ *
 * LaTeX -> MathML
 * ------------------------------------------------------------------ */

/** Characters that mark a script as an accent rather than a stacked script. */
const ACCENT_CHARS = new Set([
  '^', '\u02C6', '~', '\u02DC', '\u00AF', '\u203E', '\u02D9', '.', '\u00A8',
  '\u02C7', '\u02D8', '`', '\u00B4', '\u2192', '\u2190', '\u20D7', '\u20D6',
])

/** Accent characters rewritten to the form the OMML accent table understands. */
const ACCENT_ALIASES = { '\u02C6': '^', '\u203E': '\u00AF' }

/** Drop the presentational noise a browser renderer adds; Word ignores all of it. */
function stripMathmlNoise(mml) {
  return mml
    .replace(/\sclass="[^"]*"/g, '')
    .replace(/\sstyle="[^"]*"/g, '')
    .replace(/<mspace\b[^>]*\/>/g, '')
    .replace(/<mspace\b[^>]*><\/mspace>/g, '')
    .replace(/\u2061/g, '')
    .replace(/\s+/g, ' ')
    .replace(/>\s+</g, '><')
    .trim()
}

/**
 * Mark `<mover>`/`<munder>` scripts that are accents.
 *
 * mathml2omml only emits `m:acc` (a real Word accent) when the mover carries
 * `accent="true"`; without it the accent becomes a stacked `m:limUpp`, which looks
 * wrong in Word. Renderers never set the attribute, so it is restored here.
 */
function fixAccents(mml) {
  const tree = parseXml(mml)
  const walk = (node) => {
    for (const child of node.children) {
      if (child.name === 'mover' || child.name === 'munder') {
        const parts = child.children.filter((one) => one.name !== '#text')
        if (parts.length === 2) {
          const script = parts[1]
          const text = script.name === 'mo' ? script.children.map((one) => one.text ?? '').join('') : ''
          if (text.length === 1 && ACCENT_CHARS.has(text)) {
            if (ACCENT_ALIASES[text] !== undefined) {
              const alias = ACCENT_ALIASES[text]
              script.children = [{ name: '#text', text: alias, children: [] }]
            }
            child.attrs[child.name === 'mover' ? 'accent' : 'accentunder'] = 'true'
          }
        }
      }
      walk(child)
    }
  }
  walk(tree)
  return tree.children.map(serializeXml).join('')
}

/**
 * Render LaTeX to a MathML document that both Word and mathml2omml accept.
 * The `xmlns` is the part Word requires: without it a pasted fragment is silently
 * dropped and only the plain text survives.
 */
function buildMathML(temml, tex) {
  let mml = temml.renderToString(tex, { displayMode: true })
  mml = stripMathmlNoise(mml)
  if (!/xmlns=/.test(mml)) {
    mml = mml.replace(/<math\b/, '<math xmlns="http://www.w3.org/1998/Math/MathML"')
  }
  return fixAccents(mml)
}

/* ------------------------------------------------------------------ *
 * LaTeX -> OMML
 * ------------------------------------------------------------------ */

const MATH_FONT = '<w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/></w:rPr>'

/** Convert LaTeX to OMML, the Office Math markup Word stores an equation as. */
function toOmml(temml, mml2omml, tex) {
  const omml = mml2omml(buildMathML(temml, tex))
  /* Word writes the math font on every run; without it a foreign reader may fall
     back to a text font and lose the italic math look. */
  return omml.replace(/<m:r>(?=<m:t\b)/g, `<m:r>${MATH_FONT}`)
}

/* ------------------------------------------------------------------ *
 * Clipboard HTML for Word
 * ------------------------------------------------------------------ */

/**
 * The rich-text payload Word pastes as a native equation.
 *
 * Word's HTML importer converts a MathML `<math>` fragment into a real OMML
 * equation object. It does *not* accept hand-built OMML inside HTML — every shell
 * tried (both OMML namespaces, `oMathPara`, conditional comments) was discarded and
 * left plain text — so MathML is the transport and Word performs the final
 * MathML -> OMML step itself.
 */
function buildWordHtml(temml, tex) {
  const mml = buildMathML(temml, tex)
  return (
    '<html><head><meta charset="utf-8"></head><body><!--StartFragment-->' +
    mml +
    '<!--EndFragment--></body></html>'
  )
}

/* ------------------------------------------------------------------ *
 * LaTeX -> AsciiMath
 * ------------------------------------------------------------------ */

/** Command names that map straight to an AsciiMath spelling. */
const ASCIIMATH_SYMBOLS = {
  alpha: 'alpha', beta: 'beta', gamma: 'gamma', delta: 'delta', epsilon: 'epsilon',
  varepsilon: 'varepsilon', zeta: 'zeta', eta: 'eta', theta: 'theta', vartheta: 'vartheta',
  iota: 'iota', kappa: 'kappa', lambda: 'lambda', mu: 'mu', nu: 'nu', xi: 'xi',
  omicron: 'omicron', pi: 'pi', varpi: 'varpi', rho: 'rho', varrho: 'varrho',
  sigma: 'sigma', varsigma: 'varsigma', tau: 'tau', upsilon: 'upsilon', phi: 'phi',
  varphi: 'varphi', chi: 'chi', psi: 'psi', omega: 'omega',
  Gamma: 'Gamma', Delta: 'Delta', Theta: 'Theta', Lambda: 'Lambda', Xi: 'Xi',
  Pi: 'Pi', Sigma: 'Sigma', Upsilon: 'Upsilon', Phi: 'Phi', Psi: 'Psi', Omega: 'Omega',
  times: 'xx', div: '-:', cdot: '*', pm: '+-', mp: '-+', ast: '*', star: 'star',
  circ: '@', bullet: 'o+', oplus: 'o+', otimes: 'ox', odot: 'o.',
  le: 'le', leq: 'le', ge: 'ge', geq: 'ge', ne: 'ne', neq: 'ne', lt: 'lt', gt: 'gt',
  approx: 'approx', equiv: 'equiv', sim: '~', simeq: '~~', cong: '~=', propto: 'prop',
  ll: '<<', gg: '>>', infty: 'oo', partial: 'del', nabla: 'grad', hbar: 'hbar',
  ell: 'ell', Re: 'Re', Im: 'Im', aleph: 'aleph', emptyset: 'O/', varnothing: 'O/',
  to: '->', rightarrow: '->', leftarrow: '<-', Rightarrow: '=>', Leftarrow: '<=',
  leftrightarrow: '<->', Leftrightarrow: '<=>', mapsto: '|->', uparrow: 'uarr',
  downarrow: 'darr', rightleftharpoons: 'harpoons',
  forall: 'AA', exists: 'EE', nexists: 'not EE', neg: 'not', lnot: 'not',
  in: 'in', notin: '!in', ni: 'ni', subset: 'sub', subseteq: 'sube', supset: 'sup',
  supseteq: 'supe', cup: 'uu', cap: 'nn', setminus: '\\', complement: 'bar',
  angle: '/_', triangle: 'triangle', therefore: ':.', because: 'because',
  ldots: '...', cdots: 'cdots', dots: '...', vdots: 'vdots', ddots: 'ddots',
  prime: "'", backslash: '\\', mid: '|', vert: '|', Vert: '||',
  langle: '(:', rangle: ':)', lfloor: '|__', rfloor: '__|', lceil: '|~', rceil: '~|',
  lbrace: '{', rbrace: '}', lbrack: '[', rbrack: ']',
  sum: 'sum', prod: 'prod', coprod: 'coprod', int: 'int', iint: 'iint',
  iiint: 'iiint', oint: 'oint', bigcup: 'uuu', bigcap: 'nnn', bigoplus: 'o+',
  bigotimes: 'ox', bigvee: 'vv', bigwedge: '^^',
  quad: '\\ \\ ', qquad: '\\ \\ \\ ', enspace: '\\ ', thinspace: '\\ ',
}

/** Commands whose name is also their AsciiMath function name. */
const ASCIIMATH_FUNCTIONS = new Set([
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan',
  'sinh', 'cosh', 'tanh', 'coth', 'log', 'ln', 'lg', 'exp', 'lim', 'limsup',
  'liminf', 'max', 'min', 'sup', 'inf', 'det', 'dim', 'ker', 'deg', 'gcd', 'arg',
  'mod', 'bmod',
])

/** One-argument wrappers: `\hat{x}` -> `hat(x)`. */
const ASCIIMATH_WRAPPERS = {
  hat: 'hat', widehat: 'hat', vec: 'vec', overrightarrow: 'vec', overleftarrow: 'vec',
  bar: 'bar', overline: 'bar', tilde: 'tilde', widetilde: 'tilde',
  dot: 'dot', ddot: 'ddot', underline: 'ul', underbrace: 'ubrace', overbrace: 'obrace',
  sqrt: 'sqrt', abs: 'abs', norm: 'norm', floor: 'floor', ceil: 'ceil',
  mathbb: 'mathbb', mathbf: 'mathbf', mathcal: 'mathcal', mathfrak: 'mathfrak',
  mathsf: 'mathsf', mathtt: 'mathtt',
}

/** Commands dropped entirely, including any braced argument they take. */
const ASCIIMATH_DROPPED = new Set([
  'displaystyle', 'textstyle', 'scriptstyle', 'scriptscriptstyle',
  'limits', 'nolimits', 'nonumber', 'notag', 'hline', 'hdashline', 'cline',
  'small', 'large', 'Large', 'LARGE', 'huge', 'Huge', 'normalsize',
  'label', 'tag', 'phantom', 'hphantom', 'vphantom', 'vspace', 'hspace',
  'noindent', 'centering', 'mbox',
])

/** Delimiters that follow `\left` / `\right` / `\big` and friends. */
const ASCIIMATH_DELIMITERS = {
  '(': '(', ')': ')', '[': '[', ']': ']', '|': '|', '.': '', '/': '/', '<': '<', '>': '>',
  '\\{': '{', '\\}': '}', '\\|': '||', '\\lvert': '|', '\\rvert': '|',
  '\\langle': '(:', '\\rangle': ':)', '\\lfloor': '|__', '\\rfloor': '__|',
  '\\lceil': '|~', '\\rceil': '~|', '\\Vert': '||', '\\vert': '|',
}

/** Environment name -> the brackets its matrix is drawn with. */
const ASCIIMATH_MATRIX = {
  matrix: ['', ''], smallmatrix: ['', ''], array: ['', ''],
  pmatrix: ['(', ')'], bmatrix: ['[', ']'], Bmatrix: ['{', '}'],
  vmatrix: ['|', '|'], Vmatrix: ['||', '||'],
  /* AsciiMath writes a right brace that closes a `{` group as `:}`. */
  cases: ['{', ':}'], dcases: ['{', ':}'],
}

/** Wrap a script argument in parentheses unless it is one symbol or one character. */
function asciimathScript(argument) {
  const text = argument.trim()
  if (text.length === 0) return '()'
  /* `int_0^oo`, not `int_0^(oo)`: a bare symbol name needs no group. */
  if (/^[A-Za-z]+$/u.test(text)) return text
  if (/^[0-9]+(\.[0-9]+)?$/u.test(text)) return text
  return text.length === 1 ? text : `(${text})`
}

/** Whether `^`/`_` may attach to a piece without parenthesizing it first. */
function asciimathAttachable(piece) {
  if (/^[A-Za-z]+$/u.test(piece)) return true
  if (/^[0-9]+(\.[0-9]+)?$/u.test(piece)) return true
  /* A piece that already carries a script stays attachable: `int_0^oo`, not `(int_0)^(oo)`. */
  if (/^[A-Za-z]+(_[A-Za-z0-9]+|\^\(?[A-Za-z0-9]+\)?)+$/u.test(piece)) return true
  if (/[)\]}|\]]$/u.test(piece)) return true
  return piece.length === 1
}

/** Join emitted pieces into one AsciiMath expression. */
function asciimathJoin(pieces) {
  return pieces
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([)\]}])/g, '$1')
    .replace(/([([{])\s+/g, '$1')
    .replace(/\s+([,;])/g, '$1')
    .replace(/([,;])(?=\S)/g, '$1 ')
    /* `f (x)` and `sin (x)` read better as a call, which is how AsciiMath spells them. */
    .replace(/([A-Za-z0-9])\s+\(/g, '$1(')
    .trim()
}

/**
 * Convert LaTeX to AsciiMath.
 *
 * Hand-written rather than bundled: the candidate libraries either embed a Ruby
 * runtime of several megabytes (Plurimath) or answer nothing at all for accents,
 * and the constructs an OCR pass produces are a small, well-known set.
 */
function toAsciimath(tex) {
  const source = String(tex ?? '')
  let pos = 0

  const peek = () => (pos < source.length ? source[pos] : '')
  const skipSpace = () => {
    while (pos < source.length && /\s/u.test(source[pos])) pos += 1
  }

  /** Read a `\name` and return the name; a lone backslash-symbol returns that symbol. */
  const readName = () => {
    pos += 1
    let name = ''
    while (pos < source.length && /[A-Za-z]/u.test(source[pos])) {
      name += source[pos]
      pos += 1
    }
    if (name.length === 0 && pos < source.length) {
      name = source[pos]
      pos += 1
    }
    return name
  }

  /** Read one braced group verbatim, without interpreting it. */
  const readRawGroup = () => {
    skipSpace()
    if (peek() !== '{') return null
    pos += 1
    let depth = 1
    let text = ''
    while (pos < source.length) {
      const ch = source[pos]
      if (ch === '\\' && pos + 1 < source.length) {
        text += ch + source[pos + 1]
        pos += 2
        continue
      }
      if (ch === '{') depth += 1
      if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          pos += 1
          break
        }
      }
      text += ch
      pos += 1
    }
    return text
  }

  /** Read one argument: a braced group, or the single atom that follows. */
  const readArgument = () => {
    skipSpace()
    if (peek() === '{') return readRawGroup() ?? ''
    const saved = pos
    const piece = parseAtom()
    if (piece === '') {
      pos = saved
      return ''
    }
    return piece
  }

  /** Read an optional `[...]` argument. */
  const readOptional = () => {
    skipSpace()
    if (peek() !== '[') return null
    pos += 1
    let depth = 1
    let text = ''
    while (pos < source.length) {
      const ch = source[pos]
      if (ch === '\\' && pos + 1 < source.length) {
        text += ch + source[pos + 1]
        pos += 2
        continue
      }
      if (ch === '[') depth += 1
      if (ch === ']') {
        depth -= 1
        if (depth === 0) {
          pos += 1
          break
        }
      }
      text += ch
      pos += 1
    }
    return text
  }

  /** Split an environment body into rows of cells, honouring nesting. */
  const readEnvironment = (name) => {
    const rows = []
    let cells = []
    let cell = ''
    let depth = 0
    while (pos < source.length) {
      if (depth === 0 && source.startsWith('\\end{', pos)) {
        const close = source.indexOf('}', pos + 5)
        pos = close === -1 ? source.length : close + 1
        break
      }
      if (source.startsWith('\\begin{', pos)) depth += 1
      if (depth === 0 && source.startsWith('\\\\', pos)) {
        cells.push(cell)
        rows.push(cells)
        cells = []
        cell = ''
        pos += 2
        if (source[pos] === '[') {
          const close = source.indexOf(']', pos)
          pos = close === -1 ? source.length : close + 1
        }
        continue
      }
      if (depth === 0 && source[pos] === '&') {
        cells.push(cell)
        cell = ''
        pos += 1
        continue
      }
      if (source.startsWith('\\end{', pos)) depth -= 1
      if (source[pos] === '}') depth = Math.max(0, depth - 1)
      if (source[pos] === '{') depth += 1
      cell += source[pos]
      pos += 1
    }
    cells.push(cell)
    rows.push(cells)

    const kept = rows.filter((row) => row.some((one) => one.trim().length > 0))
    const brackets = ASCIIMATH_MATRIX[name] ?? ['', '']
    const body = kept
      .map((row) => `(${row.map((one) => toAsciimath(one)).join(', ')})`)
      .join(', ')
    if (body.length === 0) return ''
    /* `pmatrix` is one bracketed group; `cases` is a brace followed by its rows. */
    if (name === 'cases' || name === 'dcases') return `${brackets[0]}${body}${brackets[1]}`
    if (brackets[0] === '' && brackets[1] === '') return body
    return `${brackets[0]}${body}${brackets[1]}`
  }

  /** Read one atom and return its AsciiMath text. */
  const parseAtom = () => {
    skipSpace()
    if (pos >= source.length) return ''
    const ch = source[pos]

    if (ch === '{') {
      const inner = readRawGroup()
      return inner === null ? '' : toAsciimath(inner)
    }

    if (ch === '\\') {
      const name = readName()

      if (name === 'begin') {
        const env = (readRawGroup() ?? '').trim()
        return readEnvironment(env)
      }
      if (name === 'end') {
        readRawGroup()
        return ''
      }
      if (name === 'left' || name === 'right' || name === 'middle') {
        skipSpace()
        if (peek() === '\\') {
          const raw = source.slice(pos, pos + 2)
          if (ASCIIMATH_DELIMITERS[raw] !== undefined) {
            pos += 2
            return ASCIIMATH_DELIMITERS[raw]
          }
          const delim = readName()
          return ASCIIMATH_DELIMITERS[`\\${delim}`] ?? ASCIIMATH_DELIMITERS[delim] ?? delim
        }
        if (pos < source.length) {
          const delim = source[pos]
          pos += 1
          return ASCIIMATH_DELIMITERS[delim] ?? (delim === '.' ? '' : delim)
        }
        return ''
      }
      if (name === 'big' || name === 'Big' || name === 'bigg' || name === 'Bigg' ||
          name === 'bigl' || name === 'bigr' || name === 'Bigl' || name === 'Bigr' ||
          name === 'biggl' || name === 'biggr') {
        skipSpace()
        if (pos < source.length) {
          const delim = source[pos]
          pos += 1
          return ASCIIMATH_DELIMITERS[delim] ?? delim
        }
        return ''
      }
      if (name === 'frac' || name === 'dfrac' || name === 'tfrac' || name === 'cfrac') {
        const numerator = toAsciimath(readArgument())
        const denominator = toAsciimath(readArgument())
        return `frac(${numerator})(${denominator})`
      }
      if (name === 'binom' || name === 'dbinom' || name === 'tbinom') {
        const top = toAsciimath(readArgument())
        const bottom = toAsciimath(readArgument())
        return `((${top}),(${bottom}))`
      }
      if (name === 'sqrt') {
        const index = readOptional()
        const radicand = toAsciimath(readArgument())
        return index === null ? `sqrt(${radicand})` : `root(${toAsciimath(index)})(${radicand})`
      }
      if (name === 'text' || name === 'textrm' || name === 'textit' || name === 'textbf' ||
          name === 'mathrm' || name === 'operatorname' || name === 'operatorname*') {
        const raw = readRawGroup() ?? readArgument()
        if (name === 'mathrm' || name === 'operatorname' || name === 'operatorname*') {
          return toAsciimath(raw)
        }
        return `"${raw}"`
      }
      if (name === 'color' || name === 'textcolor') {
        readRawGroup()
        return toAsciimath(readArgument())
      }
      if (name === 'overset' || name === 'underset' || name === 'stackrel') {
        const over = toAsciimath(readArgument())
        const base = toAsciimath(readArgument())
        return `${base}^(${over})`
      }
      if (ASCIIMATH_WRAPPERS[name] !== undefined) {
        const inner = toAsciimath(readArgument())
        return `${ASCIIMATH_WRAPPERS[name]}(${inner})`
      }
      if (ASCIIMATH_DROPPED.has(name)) {
        skipSpace()
        if (peek() === '{') readRawGroup()
        return ''
      }
      if (name === ',' || name === ';' || name === ':' || name === '!' || name === ' ' ||
          name === 'enspace' || name === 'thinspace' || name === 'quad' || name === 'qquad') {
        return ''
      }
      if (ASCIIMATH_FUNCTIONS.has(name)) return name
      if (ASCIIMATH_SYMBOLS[name] !== undefined) return ASCIIMATH_SYMBOLS[name]
      return name
    }

    if (ch === '&') {
      pos += 1
      return ''
    }
    if (ch === '~') {
      pos += 1
      return '~'
    }
    if (ch === '-' ) {
      pos += 1
      return '-'
    }

    if (/[0-9]/u.test(ch)) {
      let digits = ''
      while (pos < source.length && /[0-9.]/u.test(source[pos])) {
        digits += source[pos]
        pos += 1
      }
      return digits
    }

    if (/[A-Za-z]/u.test(ch)) {
      let word = ''
      while (pos < source.length && /[A-Za-z]/u.test(source[pos])) {
        word += source[pos]
        pos += 1
      }
      return word
    }

    pos += 1
    return ch
  }

  /** Parse a whole sequence, applying scripts to the piece before them. */
  const parseSequence = () => {
    const pieces = []
    while (pos < source.length) {
      skipSpace()
      if (pos >= source.length) break
      const ch = source[pos]

      if (ch === '^' || ch === '_') {
        pos += 1
        const argument = toAsciimath(readArgument())
        const marker = ch === '^' ? '^' : '_'
        const wrapped = asciimathScript(argument)
        if (pieces.length === 0) {
          pieces.push(`${marker}${wrapped}`)
          continue
        }
        const last = pieces[pieces.length - 1]
        pieces[pieces.length - 1] = asciimathAttachable(last)
          ? `${last}${marker}${wrapped}`
          : `(${last})${marker}${wrapped}`
        continue
      }

      const before = pos
      const piece = parseAtom()
      if (piece === '') {
        if (pos === before) {
          /* An unreadable character must still advance, or the loop spins. */
          pos += 1
        }
        continue
      }
      pieces.push(piece)
    }
    return asciimathJoin(pieces)
  }

  return parseSequence()
}

/* ------------------------------------------------------------------ *
 * .docx
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** CRC-32 of a byte array, as the ZIP format stores it. */
function crc32(bytes) {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8)
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}

const UTF8 = typeof TextEncoder === 'function' ? new TextEncoder() : null

/** Encode text as UTF-8 bytes. */
function utf8Bytes(text) {
  if (UTF8 !== null) return UTF8.encode(text)
  const bytes = []
  for (const ch of text) {
    let code = ch.codePointAt(0)
    if (code < 0x80) {
      bytes.push(code)
    } else if (code < 0x800) {
      bytes.push(0xC0 | (code >> 6), 0x80 | (code & 0x3F))
    } else if (code < 0x10000) {
      bytes.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F))
    } else {
      bytes.push(
        0xF0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3F),
        0x80 | ((code >> 6) & 0x3F),
        0x80 | (code & 0x3F),
      )
    }
  }
  return Uint8Array.from(bytes)
}

/**
 * Build a ZIP archive with stored (uncompressed) entries.
 * @param entries - `[{ name, data }]` where `data` is a `Uint8Array`.
 */
function zipStore(entries) {
  const parts = []
  const directory = []
  let offset = 0
  const now = new Date()
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF

  for (const entry of entries) {
    const name = utf8Bytes(entry.name)
    const data = entry.data
    const checksum = crc32(data)

    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034B50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, 0x0800, true)
    lv.setUint16(8, 0, true)
    lv.setUint16(10, dosTime, true)
    lv.setUint16(12, dosDate, true)
    lv.setUint32(14, checksum, true)
    lv.setUint32(18, data.length, true)
    lv.setUint32(22, data.length, true)
    lv.setUint16(26, name.length, true)
    lv.setUint16(28, 0, true)
    local.set(name, 30)

    parts.push(local, data)

    const central = new Uint8Array(46 + name.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014B50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, 0x0800, true)
    cv.setUint16(10, 0, true)
    cv.setUint16(12, dosTime, true)
    cv.setUint16(14, dosDate, true)
    cv.setUint32(16, checksum, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, data.length, true)
    cv.setUint16(28, name.length, true)
    cv.setUint16(30, 0, true)
    cv.setUint16(32, 0, true)
    cv.setUint16(34, 0, true)
    cv.setUint16(36, 0, true)
    cv.setUint32(38, 0, true)
    cv.setUint32(42, offset, true)
    central.set(name, 46)
    directory.push(central)

    offset += local.length + data.length
  }

  const directorySize = directory.reduce((total, one) => total + one.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054B50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, directorySize, true)
  ev.setUint32(16, offset, true)

  const total = parts.reduce((sum, one) => sum + one.length, 0) + directorySize + end.length
  const out = new Uint8Array(total)
  let cursor = 0
  for (const one of parts) {
    out.set(one, cursor)
    cursor += one.length
  }
  for (const one of directory) {
    out.set(one, cursor)
    cursor += one.length
  }
  out.set(end, cursor)
  return out
}

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const M_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math'
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

/** The package parts a one-equation .docx needs, as text. */
function docxParts(omml) {
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    '</Types>'

  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    `<Relationship Id="rId1" Type="${R_NS}/officeDocument" Target="word/document.xml"/>` +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    `<Relationship Id="rId3" Type="${R_NS}/extended-properties" Target="docProps/app.xml"/>` +
    '</Relationships>'

  const documentRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    `<Relationship Id="rId1" Type="${R_NS}/styles" Target="styles.xml"/>` +
    '</Relationships>'

  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<w:document xmlns:w="${W_NS}" xmlns:m="${M_NS}" xmlns:r="${R_NS}">` +
    '<w:body>' +
    '<w:p><m:oMathPara><m:oMathParaPr><m:jc m:val="center"/></m:oMathParaPr>' +
    omml +
    '</m:oMathPara></w:p>' +
    '<w:sectPr>' +
    '<w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/>' +
    '</w:sectPr>' +
    '</w:body></w:document>'

  const stylesXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<w:styles xmlns:w="${W_NS}">` +
    '<w:docDefaults><w:rPrDefault><w:rPr>' +
    '<w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math" w:eastAsia="宋体" w:cs="Cambria Math"/>' +
    '<w:sz w:val="24"/><w:szCs w:val="24"/>' +
    '</w:rPr></w:rPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    '</w:styles>'

  const coreXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    '<dc:title>Formula</dc:title><dc:creator>dsh-formula-editor</dc:creator>' +
    '<cp:lastModifiedBy>dsh-formula-editor</cp:lastModifiedBy>' +
    '</cp:coreProperties>'

  const appXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    '<Application>dsh-formula-editor</Application>' +
    '</Properties>'

  return {
    '[Content_Types].xml': contentTypes,
    '_rels/.rels': rootRels,
    'word/_rels/document.xml.rels': documentRels,
    'word/document.xml': documentXml,
    'word/styles.xml': stylesXml,
    'docProps/core.xml': coreXml,
    'docProps/app.xml': appXml,
  }
}

/** Build the .docx bytes for one OMML equation. */
function buildDocxBytes(omml) {
  const parts = docxParts(omml)
  const entries = Object.keys(parts).map((name) => ({ name, data: utf8Bytes(parts[name]) }))
  return zipStore(entries)
}

/* The client bundle inlines this file, so the export list stays the last statement. */
export {
  buildDocxBytes,
  buildMathML,
  buildWordHtml,
  crc32,
  decodeEntities,
  docxParts,
  escapeXml,
  fixAccents,
  parseXml,
  serializeXml,
  stripMathmlNoise,
  toAsciimath,
  toOmml,
  utf8Bytes,
  zipStore,
}
