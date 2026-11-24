/**
 * Detection of something covering the page: a cookie bar, a modal, a paywall.
 *
 * The snapshot lists elements that are on screen, and a fixed overlay does not
 * remove them from the DOM or from the layout — it just sits on top. So the
 * model reads "button 7: Accept" and clicks it, nothing happens, and it tries
 * again. One line saying what covers the page ends that loop.
 *
 * Approach: sample a handful of viewport points, walk up from whatever is
 * topmost at each point, and treat elements hit at several points as covering
 * the page. Then score candidates by the signals that distinguish a real
 * obstruction from an ordinary sticky header:
 *
 * - `role=dialog` / `aria-modal` / native `<dialog open>` — declared modality
 * - a name that reads like a dialog or consent gate
 * - focus trapped inside it (the browser would not let a stray click work either)
 * - the body's scroll locked, which only a deliberate gate does
 * - a dark backdrop, its own or a sibling's
 * - a high `z-index` and a large share of the viewport
 *
 * Sampling is deliberately crude. A percentage-precise coverage map would cost a
 * layout read per element on large pages, and the answer only has to be good
 * enough to say "something is in the way, here it is".
 *
 * @module
 */

/** A thing covering the page, as reported to the model. */
export interface Obstruction {
  selector: string
  /** Human label: the element's own text, a heading inside it, or its role. */
  label: string
  /** Share of the viewport covered, 0..1. */
  coverage: number
  /** True when it is modal enough that clicks outside it cannot land. */
  blocking: boolean
}

/** Viewport sample points: five, so a small centred dialog is still detected. */
function samplePoints(width: number, height: number): Array<[number, number]> {
  return [
    [width / 2, height / 2],
    [width / 3, height / 3],
    [(2 * width) / 3, height / 3],
    [width / 3, (2 * height) / 3],
    [(2 * width) / 3, (2 * height) / 3],
  ]
}

/** Name fragments that suggest a gate rather than a page region. */
const GATE_NAME = /(modal|dialog|overlay|popup|mask|backdrop|consent|gdpr|cookie|paywall|lightbox|signin|sign-in|login)/i
/** Name fragments that suggest a bar rather than a blocking gate. */
const BAR_NAME = /(cookie|consent|gdpr|notice|banner)/i

/** Topmost element at a point, piercing open shadow roots with a cycle guard. */
function topAt(doc: Document, x: number, y: number): Element | null {
  // Hit-testing is absent in jsdom and in a document that is not rendered
  // (about:blank during a transition), so detection degrades to "nothing found"
  // rather than throwing inside every snapshot.
  if (typeof doc.elementFromPoint !== 'function') return null
  let element: Element | null
  try {
    element = doc.elementFromPoint(x, y)
  } catch {
    return null
  }
  for (let depth = 0; depth < 16 && element !== null; depth += 1) {
    const shadow = (element as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot
    if (shadow === null || shadow === undefined || typeof shadow.elementFromPoint !== 'function') break
    let inner: Element | null = null
    try {
      inner = shadow.elementFromPoint(x, y)
    } catch {
      inner = null
    }
    if (inner === null || inner === element) break
    element = inner
  }
  return element
}

/** Alpha channel of a background colour, 0 when there is no usable colour. */
function backgroundAlpha(style: CSSStyleDeclaration): number {
  const value = style.backgroundColor
  if (value === '' || value === 'transparent') return 0
  const match = /rgba?\(([^)]+)\)/i.exec(value)
  if (match === null) return 0
  const parts = match[1]!.split(',').map((part) => part.trim())
  if (parts.length === 4) return Number.parseFloat(parts[3]!) || 0
  return parts.length === 3 ? 1 : 0
}

/** A short, readable label for the obstruction. */
function labelOf(element: Element): string {
  const aria = element.getAttribute('aria-label')?.trim() ?? ''
  if (aria !== '') return aria.slice(0, 60)
  const heading = element.querySelector('h1, h2, h3, [role="heading"]')
  const headingText = (heading?.textContent ?? '').trim()
  if (headingText !== '') return headingText.slice(0, 60)
  const role = element.getAttribute('role')
  if (role !== null && role !== '') return role
  const own = (element.textContent ?? '').replace(/\s+/g, ' ').trim()
  if (own !== '') return own.slice(0, 60)
  return element.tagName.toLowerCase()
}

/** Whether the element and its ancestors keep it on screen. */
function renderedInPlace(element: Element): { style: CSSStyleDeclaration; rect: DOMRect } | null {
  let style: CSSStyleDeclaration
  try {
    style = getComputedStyle(element)
  } catch {
    return null
  }
  if (style.display === 'none' || style.visibility === 'hidden') return null
  const opacity = Number.parseFloat(style.opacity)
  // `opacity: 0` parses to 0, which is falsy: check the number, not truthiness.
  if (Number.isFinite(opacity) && opacity <= 0.1) return null
  if (style.pointerEvents === 'none') return null
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  return { style, rect }
}

/**
 * Find whatever is covering the page, if anything.
 *
 * @param doc - the document to inspect (the content script passes `document`).
 * @returns the most likely obstruction, or undefined when the page is clear.
 */
export function detectObstruction(doc: Document = document): Obstruction | undefined {
  const view = doc.defaultView
  if (view === null) return undefined
  const width = view.innerWidth
  const height = view.innerHeight
  if (width <= 0 || height <= 0) return undefined
  const area = Math.max(1, width * height)

  const body = doc.body
  const root = doc.documentElement
  if (body === null) return undefined
  const bodyStyle = getComputedStyle(body)
  const rootStyle = getComputedStyle(root)
  const scrollLocked = bodyStyle.overflow === 'hidden' || rootStyle.overflow === 'hidden'
  const active = doc.activeElement
  const activeIsReal = active !== null && active !== body && active !== root

  // How many sample points hit each element or one of its ancestors.
  const hits = new Map<Element, number>()
  for (const [x, y] of samplePoints(width, height)) {
    let element = topAt(doc, x, y)
    while (element !== null && element !== body && element !== root) {
      hits.set(element, (hits.get(element) ?? 0) + 1)
      element = element.parentElement
    }
  }
  if (hits.size === 0) return undefined

  interface Scored {
    element: Element
    rect: DOMRect
    coverage: number
    blocking: boolean
    score: number
  }

  const candidates: Scored[] = []
  for (const [element, count] of hits) {
    if (count < 1) continue
    let style: CSSStyleDeclaration
    try {
      style = getComputedStyle(element)
    } catch {
      continue
    }
    // Only positioned layers can sit on top of page content.
    if (style.position !== 'fixed' && style.position !== 'sticky') continue
    const placed = renderedInPlace(element)
    if (placed === null) continue
    const coverage = (placed.rect.width * placed.rect.height) / area
    // A third of the viewport is the floor: below that, a tooltip or a badge
    // would be reported as an obstruction.
    if (coverage < 0.33) continue

    const id = element.id
    const className = typeof element.className === 'string' ? element.className : ''
    const naming = `${id} ${className}`
    let score = 0
    const role = element.getAttribute('role')
    const isOpenDialog = element.tagName === 'DIALOG'
      && (element as HTMLDialogElement).open === true
    if (role === 'dialog' || role === 'alertdialog'
      || element.getAttribute('aria-modal') === 'true' || isOpenDialog) score += 3
    if (GATE_NAME.test(naming)) score += 2
    if (BAR_NAME.test(naming)) score += 1
    if (activeIsReal && element.contains(active)) score += 2
    if (scrollLocked) score += 1
    const selfAlpha = backgroundAlpha(style)
    if (selfAlpha > 0.3 && coverage >= 0.8) score += 2
    const zIndex = style.zIndex === 'auto' ? 0 : (Number.parseInt(style.zIndex, 10) || 0)
    if (zIndex >= 1000) score += 1
    if (coverage >= 0.6) score += 2

    candidates.push({
      element,
      rect: placed.rect,
      coverage,
      // "Blocking" is the narrower claim: it means a click on the page beneath
      // would land here. A translucent bar across the foot of the page does not
      // earn it without other signals.
      blocking: score >= 3,
      score,
    })
  }
  if (candidates.length === 0) return undefined

  candidates.sort((a, b) => b.score - a.score || b.coverage - a.coverage)
  const best = candidates[0]!
  return {
    selector: selectorFor(best.element, doc),
    label: labelOf(best.element),
    coverage: Math.round(best.coverage * 100) / 100,
    blocking: best.blocking,
  }
}

/** Minimal selector for the obstruction; ids first, then a tag chain. */
function selectorFor(element: Element, doc: Document): string {
  if (element.id !== '') {
    const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(element.id)
      : element.id.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`)
    try {
      if (doc.querySelectorAll(`#${escaped}`).length === 1) return `#${escaped}`
    } catch {
      // An id that is not a legal selector cannot name anything.
    }
  }
  const parts: string[] = []
  let node: Element | null = element
  while (node !== null && node !== doc.body && node !== doc.documentElement) {
    const tag = node.tagName.toLowerCase()
    const parent: Element | null = node.parentElement
    if (parent === null) {
      parts.unshift(tag)
      break
    }
    const sameTag = [...parent.children].filter((child) => child.tagName === node!.tagName)
    parts.unshift(sameTag.length > 1 ? `${tag}:nth-of-type(${sameTag.indexOf(node) + 1})` : tag)
    node = parent
  }
  return parts.join(' > ')
}

/**
 * One line for the snapshot, or undefined when nothing is in the way.
 *
 * Kept next to the detection so the wording cannot drift from the data: a
 * blocking overlay and a mere banner read differently, because only the first
 * makes a click impossible.
 *
 * @param obstruction - result of {@link detectObstruction}.
 * @returns a single sentence, or undefined.
 */
export function renderObstruction(obstruction: Obstruction | undefined): string | undefined {
  if (obstruction === undefined) return undefined
  const percent = Math.round(obstruction.coverage * 100)
  const label = obstruction.label === '' ? '' : ` (“${obstruction.label}”)`
  const head = obstruction.blocking
    ? `Blocking overlay: ${obstruction.selector}${label} covers ${percent}% of the viewport. Clicks on the page beneath it will not land.`
    : `Overlay: ${obstruction.selector}${label} covers ${percent}% of the viewport, but it does not appear to block clicks.`
  return head
}
