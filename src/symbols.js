/**
 * The symbol palette's data: eleven categories, each with the glyph the toolbar
 * box draws and the items its caret unfolds.
 *
 * Kept apart from src/client-ui.js so the Node tests can load it directly and
 * prove every glyph and every inserted snippet is real LaTeX that KaTeX accepts.
 *
 * Item shapes:
 *   sym  — a plain symbol: what is drawn is exactly what gets inserted.
 *   tpl  — a template: `g` is drawn, `i` carries a `|` marking the caret landing.
 *   fn   — a function name: inserted with a trailing space and the caret after it.
 *   op   — a named operator LaTeX has no macro for.
 */

/** A plain symbol: what is drawn is exactly what gets inserted. */
const sym = (tex) => ({ g: tex })

/** A template: `g` is drawn, `i` carries a `|` marking where the caret lands. */
const tpl = (glyph, insert) => ({ g: glyph, i: insert })

/** A function name: inserted with a trailing space and the caret after it. */
const fn = (name) => ({ g: `\\${name}`, i: `\\${name} |` })

/** A named operator LaTeX has no macro for. */
const op = (name) => ({ g: `\\operatorname{${name}}`, i: `\\operatorname{${name}} |` })

/**
 * The eleven categories of the palette, in the order the toolbar shows them.
 *
 * `sample` is what the category button itself draws; `items` is what its caret
 * unfolds. Items use the same shape as the buttons, so one insert path serves all.
 */
export const SYMBOL_GROUPS = [
  {
    id: 'operator',
    label: '操作符',
    sample: '\\pm/\\div',
    items: [
      '\\pm', '\\mp', '\\times', '\\div', '\\cdot', '\\ast', '\\star', '\\circ', '\\bullet',
      '\\oplus', '\\ominus', '\\otimes', '\\oslash', '\\odot', '\\cup', '\\cap', '\\wedge', '\\vee',
      '\\neg', '\\setminus', '\\leq', '\\geq', '\\neq', '\\approx', '\\equiv', '\\ll', '\\gg',
      '\\sim', '\\simeq', '\\cong', '\\propto', '\\doteq', '\\triangleq', '\\prec', '\\succ',
      '\\in', '\\notin', '\\ni', '\\subset', '\\supset', '\\subseteq', '\\supseteq',
      '\\subsetneq', '\\supsetneq', '\\vdash', '\\models', '\\therefore', '\\because',
      '\\perp', '\\parallel', '\\mid', '\\nmid',
    ].map(sym),
  },
  {
    id: 'arrow',
    label: '箭头',
    sample: '\\uparrow/\\downarrow',
    items: [
      '\\leftarrow', '\\rightarrow', '\\uparrow', '\\downarrow', '\\leftrightarrow', '\\updownarrow',
      '\\Leftarrow', '\\Rightarrow', '\\Uparrow', '\\Downarrow', '\\Leftrightarrow', '\\Updownarrow',
      '\\longleftarrow', '\\longrightarrow', '\\longleftrightarrow',
      '\\Longleftarrow', '\\Longrightarrow', '\\Longleftrightarrow',
      '\\mapsto', '\\longmapsto', '\\hookrightarrow', '\\hookleftarrow',
      '\\rightharpoonup', '\\leftharpoondown', '\\rightleftharpoons',
      '\\twoheadrightarrow', '\\twoheadleftarrow',
      '\\nearrow', '\\searrow', '\\swarrow', '\\nwarrow',
      '\\nrightarrow', '\\nleftarrow', '\\iff',
    ].map(sym),
  },
  {
    id: 'radical',
    label: '根号',
    sample: '\\sqrt{x}',
    items: [
      tpl('\\sqrt{x}', '\\sqrt{|}'),
      tpl('\\sqrt[3]{x}', '\\sqrt[3]{|}'),
      tpl('\\sqrt[4]{x}', '\\sqrt[4]{|}'),
      tpl('\\sqrt[n]{x}', '\\sqrt[n]{|}'),
      tpl('\\sqrt{\\frac{a}{b}}', '\\sqrt{\\frac{|}{}}'),
      tpl('\\sqrt{x^{2}+y^{2}}', '\\sqrt{x^{2}+y^{2}}'),
      sym('\\surd'),
    ],
  },
  {
    id: 'fraction',
    label: '分数与导数',
    sample: '\\frac{a}{b}/\\frac{d}{dt}',
    items: [
      tpl('\\frac{a}{b}', '\\frac{|}{}'),
      tpl('a/b', '|/'),
      tpl('\\binom{n}{k}', '\\binom{|}{}'),
      tpl('\\frac{\\partial y}{\\partial x}', '\\frac{\\partial |}{\\partial x}'),
      tpl('\\frac{\\partial^{2}y}{\\partial x^{2}}', '\\frac{\\partial^{2}|}{\\partial x^{2}}'),
      tpl('\\frac{dy}{dx}', '\\frac{d|}{dx}'),
      tpl('\\frac{d^{2}y}{dx^{2}}', '\\frac{d^{2}|}{dx^{2}}'),
      tpl('\\frac{1}{x}', '\\frac{1}{|}'),
      tpl('\\frac{\\Delta y}{\\Delta x}', '\\frac{\\Delta |}{\\Delta x}'),
    ],
  },
  {
    id: 'script',
    label: '上下标',
    sample: 'x^{a}/x_{a}',
    items: [
      tpl('x^{a}', 'x^{|}'),
      tpl('x_{a}', 'x_{|}'),
      tpl('x_{a}^{b}', 'x_{|}^{}'),
      tpl('{}_{a}^{b}x', '{}_{|}^{}x'),
      tpl('x^{a^{b}}', 'x^{|^{}}'),
      tpl('x_{a_{b}}', 'x_{|_{}}'),
      tpl('{}^{a}', '^{|}'),
      tpl('{}_{a}', '_{|}'),
    ],
  },
  {
    id: 'large',
    label: '大型运算符',
    sample: '\\sum/\\prod',
    items: [
      tpl('\\sum_{i=1}^{n}', '\\sum_{|}^{}'),
      tpl('\\prod_{i=1}^{n}', '\\prod_{|}^{}'),
      tpl('\\coprod_{i=1}^{n}', '\\coprod_{|}^{}'),
      tpl('\\int_{a}^{b}', '\\int_{|}^{}'),
      tpl('\\iint', '\\iint_{|}^{}'),
      tpl('\\iiint', '\\iiint_{|}^{}'),
      tpl('\\oint', '\\oint_{|}^{}'),
      tpl('\\int', '\\int |'),
      tpl('\\sum', '\\sum |'),
      sym('\\bigcup'), sym('\\bigcap'), sym('\\bigoplus'), sym('\\bigotimes'),
      sym('\\bigvee'), sym('\\bigwedge'), sym('\\biguplus'), sym('\\bigsqcup'),
    ],
  },
  {
    id: 'limit',
    label: '极限与对数',
    sample: '\\lim/\\log',
    items: [
      tpl('\\lim_{x \\to 0}', '\\lim_{| \\to }'),
      tpl('\\limsup_{n \\to \\infty}', '\\limsup_{| \\to \\infty}'),
      tpl('\\liminf_{n \\to \\infty}', '\\liminf_{| \\to \\infty}'),
      tpl('\\max_{x}', '\\max_{|}'),
      tpl('\\min_{x}', '\\min_{|}'),
      tpl('\\sup_{n}', '\\sup_{|}'),
      tpl('\\inf_{n}', '\\inf_{|}'),
      tpl('\\log_{a}', '\\log_{|}'),
      sym('\\ln'), sym('\\lg'), sym('\\exp'), sym('\\det'), sym('\\dim'), sym('\\ker'),
      sym('\\deg'), sym('\\arg'), sym('\\hom'), sym('\\gcd'), sym('\\Pr'),
      op('tr'),
      tpl('\\to', '\\to |'),
    ],
  },
  {
    id: 'trig',
    label: '三角与双曲',
    sample: '\\sin/\\cos',
    items: [
      fn('sin'), fn('cos'), fn('tan'), fn('cot'), fn('sec'), fn('csc'),
      fn('arcsin'), fn('arccos'), fn('arctan'),
      fn('sinh'), fn('cosh'), fn('tanh'), fn('coth'),
      op('sech'), op('csch'), op('arccot'),
      tpl('\\sin^{2}x', '\\sin^{2}|'),
      tpl('\\cos^{-1}x', '\\cos^{-1}|'),
    ],
  },
  {
    id: 'greek',
    label: '希腊字母',
    sample: '\\alpha/\\beta',
    items: [
      '\\alpha', '\\beta', '\\gamma', '\\delta', '\\epsilon', '\\varepsilon', '\\zeta', '\\eta',
      '\\theta', '\\vartheta', '\\iota', '\\kappa', '\\lambda', '\\mu', '\\nu', '\\xi',
      '\\pi', '\\varpi', '\\rho', '\\varrho', '\\sigma', '\\varsigma', '\\tau', '\\upsilon',
      '\\phi', '\\varphi', '\\chi', '\\psi', '\\omega',
      '\\Gamma', '\\Delta', '\\Theta', '\\Lambda', '\\Xi', '\\Pi', '\\Sigma',
      '\\Upsilon', '\\Phi', '\\Psi', '\\Omega',
    ].map(sym),
  },
  {
    id: 'accent',
    label: '重音符号',
    sample: '\\hat{a}/\\ddot{a}',
    items: [
      tpl('\\acute{a}', '\\acute{|}'),
      tpl('\\grave{a}', '\\grave{|}'),
      tpl('\\hat{a}', '\\hat{|}'),
      tpl('\\check{a}', '\\check{|}'),
      tpl('\\breve{a}', '\\breve{|}'),
      tpl('\\tilde{a}', '\\tilde{|}'),
      tpl('\\bar{a}', '\\bar{|}'),
      tpl('\\vec{a}', '\\vec{|}'),
      tpl('\\dot{a}', '\\dot{|}'),
      tpl('\\ddot{a}', '\\ddot{|}'),
      tpl('\\mathring{a}', '\\mathring{|}'),
      tpl('\\widehat{abc}', '\\widehat{|}'),
      tpl('\\widetilde{abc}', '\\widetilde{|}'),
      tpl('\\overline{abc}', '\\overline{|}'),
      tpl('\\underline{abc}', '\\underline{|}'),
      tpl('\\overbrace{abc}', '\\overbrace{|}'),
      tpl('\\underbrace{abc}', '\\underbrace{|}'),
      tpl('\\overrightarrow{AB}', '\\overrightarrow{|}'),
      tpl('\\overleftarrow{AB}', '\\overleftarrow{|}'),
      tpl('\\overleftrightarrow{AB}', '\\overleftrightarrow{|}'),
    ],
  },
  {
    id: 'other',
    label: '其它符号',
    sample: '\\infty/\\angle',
    items: [
      '\\infty', '\\angle', '\\partial', '\\nabla', '\\hbar', '\\ell', '\\Re', '\\Im', '\\aleph',
      '\\emptyset', '\\varnothing', '\\prime', '\\dots', '\\cdots', '\\vdots', '\\ddots',
      '\\square', '\\blacksquare', '\\triangle', '\\blacktriangle', '\\bigcirc',
      '\\dagger', '\\ddagger', '\\sharp', '\\flat', '\\natural',
      '\\clubsuit', '\\diamondsuit', '\\heartsuit', '\\spadesuit',
      '\\forall', '\\exists', '\\nexists', '\\top', '\\bot', '\\surd',
      '\\S', '\\P', '\\copyright', '\\pounds', '\\yen',
      '\\checkmark', '\\maltese', '\\measuredangle', '\\sphericalangle',
    ].map(sym).concat([tpl('90^{\\circ}', '^{\\circ}')]),
  },
]

/** The math styles the T button wraps a selection in. */
export const STYLE_ACTIONS = [
  { id: 'mathrm', label: '正体 \\mathrm', open: '\\mathrm{', close: '}' },
  { id: 'mathbf', label: '粗体 \\mathbf', open: '\\mathbf{', close: '}' },
  { id: 'mathit', label: '斜体 \\mathit', open: '\\mathit{', close: '}' },
  { id: 'mathbb', label: '空心 \\mathbb', open: '\\mathbb{', close: '}' },
  { id: 'mathcal', label: '花体 \\mathcal', open: '\\mathcal{', close: '}' },
  { id: 'mathfrak', label: '哥特 \\mathfrak', open: '\\mathfrak{', close: '}' },
  { id: 'mathsf', label: '无衬线 \\mathsf', open: '\\mathsf{', close: '}' },
  { id: 'mathtt', label: '等宽 \\mathtt', open: '\\mathtt{', close: '}' },
  { id: 'text', label: '文本 \\text', open: '\\text{', close: '}' },
  { id: 'overline', label: '上划线 \\overline', open: '\\overline{', close: '}' },
]

/**
 * Split an item into the text to insert and the caret offset inside it.
 *
 * `|` is the marker; an item without one puts the caret at the end.
 */
/** The snippet exactly as authored, caret marker and all. */
export function rawInsert(item) {
  return typeof item.i === 'string' ? item.i : item.g
}

export function splitInsert(item) {
  const raw = rawInsert(item)
  const marker = raw.indexOf('|')
  if (marker < 0) return { body: raw, caret: raw.length }
  return { body: raw.slice(0, marker) + raw.slice(marker + 1), caret: marker }
}
