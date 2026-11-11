/**
 * In-page self test for the sidebar tab.
 *
 * Runs the real React component against the real built client.js and records what
 * each control actually produced. Loaded only when the URL carries `?selftest=1`,
 * so the plain page stays a normal manual harness.
 */
;(async () => {
  const harness = window.harness
  const checks = []
  const out = document.createElement('pre')
  out.id = 'results'
  document.body.appendChild(out)

  const record = (name, ok, detail) => {
    checks.push({ name, ok, detail })
    out.textContent = checks.map((one) => `${one.ok ? 'PASS' : 'FAIL'} ${one.name}${one.detail === undefined ? '' : ` :: ${one.detail}`}`).join('\n')
  }
  const check = (name, ok, detail) => { record(name, ok === true, detail); return ok === true }

  const wait = (ms) => new Promise((done) => { setTimeout(done, ms) })
  const until = async (predicate, label, budget = 8000) => {
    const started = Date.now()
    while (Date.now() - started < budget) {
      if (predicate()) return true
      await wait(50)
    }
    throw new Error(`timed out waiting for ${label}`)
  }
  const text = () => document.querySelector('#root .dsffe-input')?.value ?? ''

  try {
    /* ---------------------------------------------------- registration */
    const { descriptor } = harness
    check('tab id', descriptor.id === 'dsh-formula-editor:editor', descriptor.id)
    check('tab title', descriptor.title() === '公式编辑器', descriptor.title())
    check('tab order', descriptor.order === 40, String(descriptor.order))
    check('tab single instance', descriptor.single === true)
    check('tab not bottom-only', descriptor.bottomOnly !== true)
    check('settings panel declared', typeof descriptor.settings?.render === 'function')
    check('styles injected', document.querySelector('style[data-plugin="dsh-formula-editor"]') !== null)

    /* ------------------------------------------- left navigation entry */
    check('panellist slot awaited', harness.slotInjections.includes('sidebar.panellist'),
      JSON.stringify(harness.slotInjections))
    const rows = harness.slots.entriesOfSlot('sidebar.panellist')
    check('left entry registered', rows.length === 1, String(rows.length))
    const row = rows[0]?.options ?? {}
    check('left entry id', row.id === 'dsh-formula-editor', row.id)
    check('left entry label', row.label() === '公式编辑器', row.label())
    check('left entry order', row.order === 40, String(row.order))
    check('left entry uses a fresh id', !['plugins', 'schedules', 'task-board', 'skill-explorer', 'dsh-market'].includes(row.id), row.id)

    const pages = harness.slots.entriesOfSlot('main')
    check('main panel registered under the same key', pages.length === 1 && pages[0].options.key === row.id,
      JSON.stringify(pages.map((one) => one.options)))

    /* The row's glyph takes the size the panel row hands it, and keeps the
       shipped icons' contract: a square SVG on the 16-unit grid, at the same
       stroke width, so it neither widens the row nor changes its line height. */
    const glyphHost = document.createElement('div')
    document.body.appendChild(glyphHost)
    ReactDOM.createRoot(glyphHost).render(React.createElement(rows[0].component, { size: 18, active: false }))
    await until(() => glyphHost.querySelector('.dsffe-glyph') !== null, 'the nav glyph')
    const glyph = glyphHost.querySelector('.dsffe-glyph')
    check('nav glyph is an svg', glyph.tagName.toLowerCase() === 'svg', glyph.tagName)
    check('nav glyph honours size', glyph.getAttribute('width') === '18' && glyph.getAttribute('height') === '18',
      `${glyph.getAttribute('width')}x${glyph.getAttribute('height')}`)
    check('nav glyph keeps the icon grid', glyph.getAttribute('viewBox') === '0 0 16 16', glyph.getAttribute('viewBox'))
    check('nav glyph matches the icon stroke', glyph.getAttribute('stroke-width') === '1.3', glyph.getAttribute('stroke-width'))
    check('nav glyph draws the sigma', glyph.querySelectorAll('path').length === 1, String(glyph.querySelectorAll('path').length))
    const box = glyph.getBoundingClientRect()
    check('nav glyph is square', Math.abs(box.width - box.height) < 0.5, `${box.width}x${box.height}`)
    check('nav glyph does not exceed the handed size', box.width <= 18.5, String(box.width))

    /* Clicking the row is the sidebar's job; here the page it targets must mount. */
    const pageHost = document.createElement('div')
    document.body.appendChild(pageHost)
    ReactDOM.createRoot(pageHost).render(React.createElement(pages[0].component, {}))
    await until(() => pageHost.querySelector('.dsffe-page') !== null, 'the main page')
    check('main page renders the editor', pageHost.querySelector('.dsffe-page .dsffe-input') !== null)
    check('main page has a heading', pageHost.querySelector('.dsffe-title')?.textContent === '公式编辑器',
      pageHost.querySelector('.dsffe-title')?.textContent)
    check('main page keeps the two buttons', pageHost.querySelectorAll('.dsffe-main').length === 2,
      String(pageHost.querySelectorAll('.dsffe-main').length))
    check('main page has no iframe', pageHost.querySelectorAll('iframe').length === 0)

    /* ---------------------------------------------------- initial layout */
    /* Scoped to the tab's own mount: the main-page probe above mounted a second
       editor into the document, and only this one is the sidebar tab. */
    await until(() => document.querySelector('#root .dsffe-preview') !== null, 'the tab to mount')
    check('two primary buttons', document.querySelectorAll('#root .dsffe-main').length === 2, String(document.querySelectorAll('#root .dsffe-main').length))
    const mains = [...document.querySelectorAll('#root .dsffe-main')].map((one) => one.textContent)
    check('button A label', mains[0] === '复制LaTeX', mains[0])
    check('button B label', mains[1] === '复制MathML(Word)', mains[1])
    check('drop zone present', document.querySelector('#root .dsffe-drop') !== null)
    check('source textarea present', document.querySelector('#root .dsffe-input') !== null)
    check('no iframe anywhere', document.querySelectorAll('iframe').length === 0)

    /* ------------------------------------------- editable formula surface */
    await until(() => window.katex !== undefined, 'KaTeX to load')
    check('katex stylesheet linked', document.querySelector('#dsh-formula-editor-katex-css') !== null)
    await until(() => window.MathfieldElement !== undefined, 'MathLive to load', 20000)
    check('mathlive stylesheet linked', document.querySelector('#dsh-formula-editor-mathlive-css') !== null)
    check('mathlive font stylesheet linked', document.querySelector('#dsh-formula-editor-mathlive-fonts') !== null)
    check('mathlive registered the element', window.customElements.get('math-field') !== undefined)
    await until(() => harness.field() !== null, 'the formula field to mount', 20000)
    check('formula surface is a math-field', harness.field() !== null)
    /* The shadow parts are reachable, and the two chrome buttons MathLive adds
       (soft keyboard, menu) are hidden through those parts. */
    const shadow = harness.field().shadowRoot
    const toggle = shadow.querySelector('[part~="virtual-keyboard-toggle"]')
    const menu = shadow.querySelector('[part~="menu-toggle"]')
    check('mathlive exposes its chrome parts', toggle !== null && menu !== null,
      `${toggle !== null} ${menu !== null}`)
    check('formula surface hides the keyboard toggle',
      toggle !== null && getComputedStyle(toggle).display === 'none',
      toggle === null ? 'no toggle' : getComputedStyle(toggle).display)
    check('formula surface hides the menu toggle',
      menu !== null && getComputedStyle(menu).display === 'none',
      menu === null ? 'no menu' : getComputedStyle(menu).display)
    /* Fonts load lazily from the stylesheet; asking the font set proves the URL resolves. */
    const fontLoaded = await document.fonts.load('1em KaTeX_Main').then(() => document.fonts.check('1em KaTeX_Main')).catch(() => false)
    check('katex font loaded from same origin', fontLoaded === true, String(fontLoaded))

    /* Typing in the source box must reach the formula surface. */
    harness.type('\\frac{a+b}{c-d}')
    await until(() => harness.fieldValue() === '\\frac{a+b}{c-d}', 'the source to reach the field', 8000)
    check('source edit reaches the formula', harness.fieldValue() === '\\frac{a+b}{c-d}', JSON.stringify(harness.fieldValue()))
    check('formula draws no raw source', harness.field().shadowRoot.querySelector('.ML__latex') !== null)

    /* And the other direction: an edit inside the formula rewrites the source.
       The placeholder MathLive parks the caret in never reaches the source. */
    harness.fieldClear()
    await wait(30)
    harness.fieldType('x^2')
    await until(() => text() === 'x^2', 'the field edit to reach the source', 8000)
    check('formula edit reaches the source', text() === 'x^2', JSON.stringify(text()))
    check('placeholder never reaches the source', !text().includes('\\placeholder'), JSON.stringify(text()))

    /* ---------------------------------------------------- symbol palette */
    /* Every category box must exist, draw its sample through KaTeX, and unfold
       a non-empty gallery. Then one item has to actually edit the source. */
    const expectedCategories = ['操作符', '箭头', '根号', '分数与导数', '上下标', '大型运算符',
      '极限与对数', '三角与双曲', '希腊字母', '重音符号', '其它符号']
    await until(() => harness.categories().length === expectedCategories.length, 'the palette to mount')
    const cats = harness.categories()
    check('palette: 11 categories', cats.length === 11, String(cats.length))
    const catLabels = cats.map((one) => one.querySelector('.dsffe-cat-label > span')?.textContent)
    check('palette: labels in order', JSON.stringify(catLabels) === JSON.stringify(expectedCategories), JSON.stringify(catLabels))
    check('palette: every category draws KaTeX', cats.every((one) => one.querySelector('.dsffe-cat-glyph .katex') !== null),
      String(cats.filter((one) => one.querySelector('.dsffe-cat-glyph .katex') === null).length) + ' without glyph')
    check('palette: no broken glyph', document.querySelectorAll('#root .dsffe-cat-glyph .dsffe-broken').length === 0,
      String(document.querySelectorAll('#root .dsffe-cat-glyph .dsffe-broken').length))
    check('palette: every category has a caret', cats.every((one) => one.querySelector('.dsffe-cat-caret') !== null))

    /* Each category unfolds its own gallery; the item count must match the data. */
    const expectedCounts = [52, 34, 7, 9, 8, 17, 21, 18, 40, 20, 46]
    const seenCounts = []
    for (let index = 0; index < cats.length; index += 1) {
      harness.openCategory(index)
      const id = cats[index].getAttribute('data-group')
      await until(() => harness.categoryItems(id).length > 0, `category ${id} to open`)
      const items = harness.categoryItems(id)
      seenCounts.push(items.length)
      /* The glyphs render in an effect, so wait for KaTeX before judging them.
         A refused snippet falls back to `.dsffe-broken` inside the button. */
      const drawn = () => harness.categoryItems(id).every((one) => one.querySelector('.katex') !== null || one.querySelector('.dsffe-broken') !== null)
      await until(drawn, `${id} glyphs to render`, 20000).catch(() => {})
      const undrawn = harness.categoryItems(id).filter((one) => one.querySelector('.katex') === null && one.querySelector('.dsffe-broken') === null)
      const broken = harness.categoryItems(id).filter((one) => one.querySelector('.dsffe-broken') !== null)
      check(`palette: ${id} opens`, items.length > 0, String(items.length))
      check(`palette: ${id} glyphs all drawn`, undrawn.length === 0, undrawn.map((one) => one.title).join(' | '))
      check(`palette: ${id} no broken glyph`, broken.length === 0, broken.map((one) => one.title).join(' | '))
      cats[index].click()
      await wait(30)
    }
    check('palette: item counts match the data', JSON.stringify(seenCounts) === JSON.stringify(expectedCounts), JSON.stringify(seenCounts))
    check('palette: no menu left open', document.querySelectorAll('#root .dsffe-cat-menu').length === 0,
      String(document.querySelectorAll('#root .dsffe-cat-menu').length))

    /* Inserting: a template must land at the caret and leave the cursor inside it. */
    harness.type('')
    await wait(30)
    harness.type('x = ')
    await wait(30)
    harness.selectRange(4, 4)
    harness.openCategoryById('fraction')
    await until(() => harness.categoryItems('fraction').length > 0, 'the fraction gallery')
    harness.categoryItems('fraction')[0].click()
    await wait(60)
    check('palette: template inserted at the caret', text() === 'x = \\frac{}{}', JSON.stringify(text()))
    check('palette: caret lands inside the template', harness.caret().start === 10, JSON.stringify(harness.caret()))
    check('palette: gallery closed after insert', document.querySelectorAll('#root .dsffe-cat-menu').length === 0)

    /* A plain symbol replaces the selection instead of being appended. */
    harness.type('abcdef')
    await wait(30)
    harness.selectRange(1, 4)
    harness.openCategoryById('greek')
    await until(() => harness.categoryItems('greek').length > 0, 'the greek gallery')
    harness.categoryItems('greek')[0].click()
    await wait(60)
    check('palette: symbol replaces the selection', text() === 'a\\alphaef', JSON.stringify(text()))

    /* A function name leaves a space and puts the caret after it. */
    harness.type('')
    await wait(30)
    harness.openCategoryById('trig')
    await until(() => harness.categoryItems('trig').length > 0, 'the trig gallery')
    harness.categoryItems('trig')[0].click()
    await wait(60)
    check('palette: function inserts a name', text() === '\\sin ', JSON.stringify(text()))
    check('palette: caret after the function name', harness.caret().start === 5, JSON.stringify(harness.caret()))

    /* ---------------------------------------------------- editing tools */
    harness.type('\\frac{a}{b}')
    await wait(50)
    check('tools: undo enabled after an edit', harness.tool('undo').disabled === false)
    harness.tool('undo').click()
    await wait(50)
    check('tools: undo restores the previous source', text() === '\\sin ', JSON.stringify(text()))
    check('tools: redo enabled after undo', harness.tool('redo').disabled === false)
    harness.tool('redo').click()
    await wait(50)
    check('tools: redo re-applies the edit', text() === '\\frac{a}{b}', JSON.stringify(text()))

    harness.type('ab')
    await wait(30)
    harness.selectRange(1, 1)
    harness.tool('newline').click()
    await wait(50)
    check('tools: newline splits at the caret', text() === 'a\nb', JSON.stringify(text()))

    /* The T button wraps whatever is selected. */
    harness.type('x')
    await wait(30)
    harness.selectRange(0, 1)
    await wait(30)
    check('tools: selection reaches the box', harness.caret().start === 0 && harness.caret().end === 1, JSON.stringify(harness.caret()))
    harness.openStyleMenu()
    await until(() => harness.styleItems().length > 0, 'the style menu')
    check('tools: style menu has 10 entries', harness.styleItems().length === 10, String(harness.styleItems().length))
    harness.styleItems()[1].click()
    await wait(60)
    check('tools: style wraps the selection', text() === '\\mathbf{x}', JSON.stringify(text()))

    /* Clearing resets the box and the toolbar. */
    harness.type('\\frac{a}{b}')
    await wait(50)
    document.querySelectorAll('#root .dsffe-tools .dsffe-tool')[0].click()
    await wait(60)
    check('tools: clear empties the source', text() === '', JSON.stringify(text()))

    /* The two copy buttons must survive the toolbar rewrite. */
    check('tools: both copy buttons still present', document.querySelectorAll('#root .dsffe-main').length === 2,
      String(document.querySelectorAll('#root .dsffe-main').length))

    /* ------------------------------------- palette acts on the formula too */
    /* The palette follows whichever surface last held the caret, so a template
       picked while editing the formula lands in the formula, not the source. */
    harness.type('')
    await wait(50)
    harness.field().focus()
    await wait(30)
    harness.openCategoryById('fraction')
    await until(() => harness.categoryItems('fraction').length > 0, 'the fraction gallery')
    harness.categoryItems('fraction')[0].click()
    await wait(80)
    check('palette: template lands in the formula', text() === '\\frac{}{}', JSON.stringify(text()))
    check('palette: formula edit reaches the source', text() === '\\frac{}{}', JSON.stringify(text()))
    /* Typing continues inside the numerator the template opened. */
    harness.fieldType('p')
    await wait(80)
    check('palette: caret sits inside the inserted template', text() === '\\frac{p}{}', JSON.stringify(text()))

    /* Undo works from the formula surface as well. */
    harness.tool('undo').click()
    await wait(60)
    check('tools: undo works from the formula', text() === '\\frac{}{}', JSON.stringify(text()))
    harness.tool('redo').click()
    await wait(60)
    check('tools: redo works from the formula', text() === '\\frac{p}{}', JSON.stringify(text()))

    /* Clearing from the formula leaves both surfaces empty. */
    document.querySelectorAll('#root .dsffe-tools .dsffe-tool')[0].click()
    await wait(60)
    check('tools: clear empties the formula too', text() === '' && harness.fieldValue() === '',
      `${JSON.stringify(text())} ${JSON.stringify(harness.fieldValue())}`)

    /* ---------------------------------------------------- menu A labels */
    const expectedA = ['无特殊附加', '$ ... $ 格式', '$$ ... $$ 格式', '\\[ ... \\] 格式', '\\( ... \\) 格式', '\\begin{equation} ... \\end{equation} 格式']
    harness.openMenu(0)
    await until(() => document.querySelectorAll('#root .dsffe-menu .dsffe-item').length > 0, 'menu A to open')
    const labelsA = harness.labels()
    check('menu A has 6 items', labelsA.length === 6, String(labelsA.length))
    check('menu A labels exact', JSON.stringify(labelsA) === JSON.stringify(expectedA), JSON.stringify(labelsA))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wait(50)

    /* ---------------------------------------------------- menu A output */
    const source = '\\frac{a+b}{c-d}'
    /* The tools above emptied the box; the copy actions need a formula again. */
    harness.type(source)
    await wait(50)
    const expected = {
      '无特殊附加': source,
      '$ ... $ 格式': `$ ${source} $`,
      '$$ ... $$ 格式': `$$ ${source} $$`,
      '\\[ ... \\] 格式': `\\[ ${source} \\]`,
      '\\( ... \\) 格式': `\\( ${source} \\)`,
      '\\begin{equation} ... \\end{equation} 格式': `\\begin{equation}\n${source}\n\\end{equation}`,
    }
    for (let index = 0; index < expectedA.length; index += 1) {
      harness.clipboard.text = null
      harness.openMenu(0)
      await until(() => document.querySelectorAll('#root .dsffe-menu .dsffe-item').length > 0, 'menu A')
      const items = [...document.querySelectorAll('#root .dsffe-menu .dsffe-item')]
      items[index].click()
      await until(() => harness.clipboard.text !== null, `clipboard after item ${index}`)
      const label = expectedA[index]
      check(`menu A item ${index + 1} copy`, harness.clipboard.text === expected[label], JSON.stringify(harness.clipboard.text))
    }

    /* ---------------------------------------------------- menu B labels */
    const expectedB = ['复制MathML(Word)', '复制AsciiMath', '复制Typst', '导出Docx(Word/WPS)']
    harness.openMenu(1)
    await until(() => document.querySelectorAll('#root .dsffe-menu .dsffe-item').length > 0, 'menu B to open')
    const labelsB = harness.labels()
    check('menu B has 4 items', labelsB.length === 4, String(labelsB.length))
    check('menu B labels exact', JSON.stringify(labelsB) === JSON.stringify(expectedB), JSON.stringify(labelsB))

    /* ---------------------------------------------------- Word clipboard */
    harness.clipboard.html = null
    harness.clipboard.plain = null
    const probe = new ClipboardItem({
      'text/html': new Blob(['<b>x</b>'], { type: 'text/html' }),
      'text/plain': new Blob(['x'], { type: 'text/plain' }),
    })
    check('ClipboardItem keeps both flavours', probe.types.length === 2, JSON.stringify(probe.types))
    ;[...document.querySelectorAll('#root .dsffe-menu .dsffe-item')][0].click()
    await until(() => harness.clipboard.html !== null, 'the Word clipboard write', 20000)
    /* The flavours are read out of the item one await at a time, so the plain text
       lands a tick after the html one. */
    await until(() => harness.clipboard.plain !== null, 'the plain-text flavour', 5000).catch(() => {})
    const html = harness.clipboard.html
    check('word: text/html written', typeof html === 'string' && html.length > 0)
    check('word: carries MathML', html.includes('<math') && html.includes('xmlns="http://www.w3.org/1998/Math/MathML"'))
    check('word: carries mfrac', html.includes('<mfrac>'))
    check('word: not raw LaTeX only', !/^\\frac/.test(html.trim()))
    check('word: fragment markers', html.includes('<!--StartFragment-->') && html.includes('<!--EndFragment-->'))
    check('word: text/plain fallback', harness.clipboard.plain === source, JSON.stringify(harness.clipboard.plain))

    /* ---------------------------------------------------- AsciiMath */
    harness.clipboard.text = null
    harness.openMenu(1)
    await until(() => document.querySelectorAll('#root .dsffe-menu .dsffe-item').length > 0, 'menu B')
    ;[...document.querySelectorAll('#root .dsffe-menu .dsffe-item')][1].click()
    await until(() => harness.clipboard.text !== null, 'the AsciiMath write')
    /* `frac(a + b)(c - d)` is the standard AsciiMath function form; what matters is that
       no LaTeX command survives and the structure is recognisable. */
    check('asciimath copied', /^(frac\(a \+ b\)\(c - d\)|\(a \+ b\)\/\(c - d\))$/.test(harness.clipboard.text), JSON.stringify(harness.clipboard.text))
    check('asciimath has no latex command', !/\\[a-z]+/i.test(harness.clipboard.text), JSON.stringify(harness.clipboard.text))

    /* ---------------------------------------------------- Typst */
    harness.clipboard.text = null
    harness.openMenu(1)
    await until(() => document.querySelectorAll('#root .dsffe-menu .dsffe-item').length > 0, 'menu B')
    ;[...document.querySelectorAll('#root .dsffe-menu .dsffe-item')][2].click()
    await until(() => harness.clipboard.text !== null, 'the Typst write')
    check('typst copied', typeof harness.clipboard.text === 'string' && harness.clipboard.text.length > 0, JSON.stringify(harness.clipboard.text))

    /* ---------------------------------------------------- .docx download */
    const captured = { blob: null, name: null }
    const realCreate = URL.createObjectURL
    URL.createObjectURL = (blob) => { captured.blob = blob; return realCreate.call(URL, blob) }
    const realClick = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function noop() { captured.name = this.download }
    harness.openMenu(1)
    await until(() => document.querySelectorAll('#root .dsffe-menu .dsffe-item').length > 0, 'menu B')
    ;[...document.querySelectorAll('#root .dsffe-menu .dsffe-item')][3].click()
    await until(() => captured.blob !== null, 'the docx download', 20000)
    URL.createObjectURL = realCreate
    HTMLAnchorElement.prototype.click = realClick
    check('docx: filename', captured.name === 'formula.docx', String(captured.name))
    check('docx: mime', captured.blob.type.includes('wordprocessingml'), captured.blob.type)
    const bytes = new Uint8Array(await captured.blob.arrayBuffer())
    const head = String.fromCharCode(...bytes.slice(0, 2))
    check('docx: zip signature', head === 'PK', head)
    check('docx: size sane', bytes.length > 2000, `${bytes.length} bytes`)
    const asText = new TextDecoder().decode(bytes)
    check('docx: carries document.xml', asText.includes('word/document.xml'))
    check('docx: carries OMML', asText.includes('<m:oMath'), '')
    check('docx: no MathML left', !asText.includes('<math'), '')
    harness.docxBytes = bytes

    /* ---------------------------------------------------- OCR via drop */
    harness.type('')
    await wait(50)
    const png = await (await fetch('/plugins/dsh-formula-editor/assets/katex/fonts/KaTeX_Main-Regular.woff2')).arrayBuffer()
    /* Any image bytes do the job: the host half is stubbed, only the plumbing matters. */
    const imageFile = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'shot.png', { type: 'image/png' })
    const transfer = new DataTransfer()
    transfer.items.add(imageFile)
    document.querySelector('#root .dsffe-root').dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }))
    await until(() => text().length > 0, 'the OCR result to land in the textarea', 20000)
    check('ocr: image accepted by drop', harness.requests.some((one) => one.path.endsWith('/ocr')), JSON.stringify(harness.requests))
    check('ocr: latex filled into the box', text() === (harness.canned.ocr ?? '\\frac{a+b}{c-d}'), JSON.stringify(text()))
    check('ocr: thumbnail shown', document.querySelector('#root .dsffe-thumb img') !== null)
    await until(() => harness.fieldValue() === (harness.canned.ocr ?? '\\frac{a+b}{c-d}'), 'the OCR result to reach the formula', 20000)

    /* Editing the recognized formula must not break re-recognition: the image is
       kept, so one more click on the recognize button restores what it saw. */
    const recognized = harness.canned.ocr ?? '\\frac{a+b}{c-d}'
    harness.fieldType('+1')
    await until(() => text() !== recognized, 'the recognized formula to be edited', 8000)
    check('ocr: the recognized formula is editable', text() !== recognized, JSON.stringify(text()))
    document.querySelector('#root .dsffe-row .dsffe-btn').click()
    await until(() => text() === recognized, 're-recognition to restore the formula', 20000)
    check('ocr: re-recognition restores the image formula', text() === recognized, JSON.stringify(text()))
    check('ocr: the restored formula reaches the field', harness.fieldValue() === recognized, JSON.stringify(harness.fieldValue()))

    /* ---------------------------------------------------- settings panel */
    const settingsHost = document.createElement('div')
    settingsHost.id = 'settings'
    document.body.appendChild(settingsHost)
    const settingsProps = {
      store: {},
      service: {},
      prefs: {},
      pluginSettings: {},
      updatePluginSetting() {},
      close() {},
    }
    ReactDOM.createRoot(settingsHost).render(React.createElement(harness.settingsRender, settingsProps))
    await until(() => document.querySelector('#settings input[type=password]') !== null, 'the settings panel')
    await until(() => settingsHost.textContent.includes('当前状态'), 'the settings status line')
    check('settings: password input', document.querySelector('#settings input[type=password]') !== null)
    check('settings: shows configured state', settingsHost.textContent.includes('已配置'), settingsHost.textContent.slice(0, 120))
    check('settings: shows endpoint', settingsHost.textContent.includes('vision.example'))

    record('summary', checks.every((one) => one.ok), `${checks.filter((one) => one.ok).length}/${checks.length}`)
  } catch (problem) {
    record('harness crashed', false, problem instanceof Error ? `${problem.message}\n${problem.stack ?? ''}` : String(problem))
  } finally {
    out.textContent += `\nDONE ${checks.filter((one) => one.ok).length}/${checks.length}`
    document.title = checks.every((one) => one.ok) ? 'SELFTEST-OK' : 'SELFTEST-FAIL'
  }
})()
