/**
 * Query-based element locator for the `browser_snapshot { query }` action.
 *
 * The snapshot inventory only lists semantically interactive elements, so rich
 * editors, canvas apps and SVG surfaces keep their real controls out of reach.
 * This module locates any element by text, selector or role and reports the
 * geometry a trusted pointer needs, without knowing anything about the app.
 *
 * The locator is deliberately app-agnostic: it treats every element alike and
 * never keys on a domain, component class or editor implementation.
 *
 * @module
 */

import { accessibleName } from './extract.ts'

/** One locator request as supplied by the model. */
export interface LocatorQuery {
  text?: string
  selector?: string
  role?: string
  includeHidden?: boolean
  limit?: number
}

/** Viewport-relative geometry in CSS pixels (the frame's own viewport). */
export interface ElementGeometry {
  x: number
  y: number
  width: number
  height: number
}

/** One located element with everything the model needs to act on it. */
export interface FoundElement {
  element: Element
  selector: string
  rect: ElementGeometry
  visible: boolean
  editable: boolean
  focusable: boolean
  label: string
  role: string
}

/** Bounded scan so a giant page cannot stall one tool call. */
const MAX_SCANNED_ELEMENTS = 20_000

/** Label cap; the snapshot uses the same width for inventory names. */
const LABEL_MAX_CHARS = 80

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 30

/** Tags that never carry usable text or interaction of their own. */
const SKIPPED_TAGS = new Set([
  'html',
  'head',
  'body',
  'script',
  'style',
  'meta',
  'link',
  'title',
  'noscript',
  'template',
])

/** Explicit role, else the browser's implicit role for common form/content tags. */
export function roleOfElement(el: Element): string {
  const explicit = el.getAttribute('role')
  if (explicit !== null && explicit.trim() !== '') return explicit.trim()
  if (el instanceof HTMLAnchorElement) return el.hasAttribute('href') ? 'link' : 'generic'
  if (el instanceof HTMLButtonElement) return 'button'
  if (el instanceof HTMLInputElement) {
    switch (el.type) {
      case 'checkbox': return 'checkbox'
      case 'radio': return 'radio'
      case 'button':
      case 'submit':
      case 'reset': return 'button'
      case 'range': return 'slider'
      case 'search': return 'searchbox'
      default: return 'textbox'
    }
  }
  if (el instanceof HTMLTextAreaElement) return 'textbox'
  if (el instanceof HTMLSelectElement) return 'combobox'
  if (el instanceof HTMLElement && el.isContentEditable) return 'textbox'
  if (/^h[1-6]$/i.test(el.tagName)) return 'heading'
  if (el instanceof HTMLImageElement) return 'img'
  return 'generic'
}

/** Whether an element can take keyboard focus, even when it has no size (editor proxies). */
export function isFocusableElement(el: Element): boolean {
  if (!(el instanceof HTMLElement)) {
    return el.hasAttribute('tabindex') || el.getAttribute('contenteditable') === 'true'
  }
  if (el.isContentEditable) return true
  if (el instanceof HTMLInputElement) return !el.disabled
  if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly
  if (el instanceof HTMLSelectElement || el instanceof HTMLButtonElement) return !el.disabled
  if (el.getAttribute('tabindex') !== null) return Number(el.getAttribute('tabindex')) >= 0
  return el.hasAttribute('href')
}

/** Whether text or HTML input would land inside this element. */
export function isEditableElement(el: Element): boolean {
  if (el instanceof HTMLInputElement) return !el.disabled && !el.readOnly && el.type !== 'checkbox' && el.type !== 'radio'
  if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly
  return el instanceof HTMLElement && el.isContentEditable
}

/**
 * Whether the element renders with a box, regardless of its tag namespace.
 * `HTMLElement`-only checks would exclude every SVG node.
 */
function isRendered(el: Element): boolean {
  const style = getComputedStyle(el)
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
  const rect = el.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

/** Escape an identifier for a CSS selector. */
function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`)
}

/**
 * One selector segment for an element, indexed only when siblings share its tag.
 *
 * `:nth-of-type` rather than `:nth-child`: inserting an unrelated sibling (a
 * `<div>` before a list, say) shifts every `:nth-child` after it, while
 * `:nth-of-type` only moves when a sibling of the *same* tag appears.
 */
function selectorSegment(node: Element, parent: Element | null): string {
  const tag = node.tagName.toLowerCase()
  if (parent === null) return tag
  const sameTag = [...parent.children].filter((child) => child.tagName === node.tagName)
  return sameTag.length > 1 ? `${tag}:nth-of-type(${sameTag.indexOf(node) + 1})` : tag
}

/**
 * Build a selector that resolves back to this element.
 *
 * The previous version emitted `:nth-child(n)` at every level without ever
 * checking the result, so an ordinary paragraph came back as
 * `html > body > div:nth-child(3) > div:nth-child(2) > p:nth-child(1)` — long,
 * brittle, and broken by any sibling inserted before it. That matters because
 * this selector is handed to the model and resolved again on the next call: a
 * brittle selector is a click that misses.
 *
 * The rule, in one sentence: anchor at the nearest ancestor with a *unique* id
 * (verified, because duplicate ids are common), then drop leading tag-only
 * segments for as long as the shorter form still resolves to this element.
 * An id anchor is never dropped — it is what keeps the result stable when the
 * page grows around the target.
 *
 * @param el - target element.
 * @returns a CSS selector, or an empty string when the element has no document.
 */
export function uniqueSelectorFor(el: Element): string {
  const owner = el.ownerDocument
  if (owner === null) return ''
  if (el === owner.body) return 'body'
  const verify = (candidate: string): boolean => {
    try {
      const matches = owner.querySelectorAll(candidate)
      return matches.length === 1 && matches[0] === el
    } catch {
      return false
    }
  }

  if (el.id !== '') {
    const byId = `#${cssEscape(el.id)}`
    if (verify(byId)) return byId
  }

  // Nearest ancestor whose id resolves uniquely; that id becomes the anchor.
  // Note the check is "this id matches one element in the document", not "this
  // id resolves to the target" — an ancestor by definition does not resolve to
  // its own descendant.
  let anchorNode: Element | null = null
  let anchorSelector = ''
  for (let node = el.parentElement;
    node !== null && node !== owner.body && node !== owner.documentElement;
    node = node.parentElement) {
    if (node.id === '') continue
    const byId = `#${cssEscape(node.id)}`
    try {
      if (owner.querySelectorAll(byId).length === 1) {
        anchorNode = node
        anchorSelector = byId
        break
      }
    } catch {
      // An id that is not a legal selector cannot anchor anything.
    }
  }

  const chain: Array<{ segment: string; anchor: boolean }> = []
  for (let node: Element | null = el; node !== null; node = node.parentElement) {
    if (node === anchorNode) {
      chain.unshift({ segment: anchorSelector, anchor: true })
      break
    }
    if (node === owner.body || node === owner.documentElement) break
    chain.unshift({ segment: selectorSegment(node, node.parentElement), anchor: false })
  }
  if (chain.length === 0) return ''

  // Greedy simplification: the shortest prefix-free form that still resolves.
  while (chain.length > 1 && !chain[0]!.anchor) {
    const shorter = chain.slice(1).map((entry) => entry.segment).join(' > ')
    if (!verify(shorter)) break
    chain.shift()
  }

  const selector = chain.map((entry) => entry.segment).join(' > ')
  if (verify(selector)) return selector
  // Positional fallback: correct even when the tag chain is ambiguous.
  return positionalSelectorFor(el, owner)
}

/** Absolute `:nth-child` path, used only when the semantic chain fails. */
function positionalSelectorFor(el: Element, owner: Document): string {
  const parts: string[] = []
  let node: Element | null = el
  while (node !== null && node !== owner.documentElement) {
    const parent: Element | null = node.parentElement
    if (parent === null) break
    parts.unshift(`${node.tagName.toLowerCase()}:nth-child(${[...parent.children].indexOf(node) + 1})`)
    node = parent
  }
  return parts.join(' > ')
}

/** Normalized visible text, used for label matching and reporting. */
function normalizedText(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** Whether an element's own labels (not descendants' bulk text) match the needle. */
function matchesText(el: Element, needle: string): boolean {
  const labels = [
    el.getAttribute('aria-label') ?? '',
    el.getAttribute('title') ?? '',
    el.getAttribute('placeholder') ?? '',
    el.getAttribute('alt') ?? '',
    el instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(el.type) ? el.value : '',
  ]
  for (const label of labels) {
    if (label.toLowerCase().includes(needle)) return true
  }
  const text = normalizedText(el)
  // A container whose subtree text dwarfs the query is not the element the
  // caller means; only short, self-descriptive nodes match on their own text.
  return text.length > 0 && text.length <= 200 && text.toLowerCase().includes(needle)
}

/** Thrown for malformed locator arguments so callers can map them to `bad-args`. */
export class LocatorError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LocatorError'
  }
}

/** Read and validate the model-supplied query object. */
export function parseLocatorQuery(value: unknown): LocatorQuery {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LocatorError('query must be an object with text, selector, role, includeHidden, and limit.')
  }
  const record = value as Record<string, unknown>
  const text = typeof record.text === 'string' && record.text !== '' ? record.text : undefined
  const selector = typeof record.selector === 'string' && record.selector !== '' ? record.selector : undefined
  const role = typeof record.role === 'string' && record.role !== '' ? record.role : undefined
  if (text !== undefined && selector !== undefined) {
    throw new LocatorError('query.text and query.selector are mutually exclusive.')
  }
  if (text === undefined && selector === undefined && role === undefined) {
    throw new LocatorError('query needs at least one of text, selector, or role.')
  }
  const limit = record.limit === undefined ? DEFAULT_LIMIT : record.limit
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new LocatorError(`query.limit must be an integer between 1 and ${MAX_LIMIT}.`)
  }
  return {
    ...(text === undefined ? {} : { text }),
    ...(selector === undefined ? {} : { selector }),
    ...(role === undefined ? {} : { role }),
    ...(record.includeHidden === true ? { includeHidden: true } : {}),
    limit,
  }
}

/** How many raw matches a scan keeps before visibility filtering decides. */
const MAX_MATCHES = 200

/** Candidate elements for a query, in document order. */
function candidates(query: LocatorQuery): Element[] {
  if (query.selector !== undefined) {
    try {
      return [...document.querySelectorAll(query.selector)]
    } catch {
      throw new LocatorError(`query.selector is not a valid CSS selector: ${query.selector}`)
    }
  }
  const matched: Element[] = []
  const needle = query.text?.toLowerCase()
  let scanned = 0
  for (const el of document.querySelectorAll('*')) {
    if (matched.length >= MAX_MATCHES || scanned >= MAX_SCANNED_ELEMENTS) break
    scanned += 1
    if (SKIPPED_TAGS.has(el.tagName.toLowerCase())) continue
    if (query.role !== undefined && roleOfElement(el) !== query.role) continue
    if (needle !== undefined && !matchesText(el, needle)) continue
    matched.push(el)
  }
  return matched
}

/**
 * Collapse nested matches onto the element a caller actually means.
 *
 * A container and its labelled child both satisfy a text query; returning both
 * wastes the result budget and picks wrappers over controls. The innermost
 * focusable/editable element wins, a wrapper of such a control is dropped, and
 * otherwise the innermost text carrier wins.
 *
 * @param matches - raw matches in document order.
 * @returns the matches worth reporting.
 */
function dedupeNested(matches: Element[]): Element[] {
  const semantic = new Set(matches.filter((el) => isFocusableElement(el) || isEditableElement(el)))
  return matches.filter((el) => {
    const semanticDescendant = [...semantic].some((control) => control !== el && el.contains(control))
    if (semantic.has(el)) return !semanticDescendant
    const semanticAncestor = [...semantic].some((control) => control !== el && control.contains(el))
    if (semanticAncestor) return false
    return !matches.some((other) => other !== el && el.contains(other))
  })
}

/**
 * Locate elements matching one query.
 *
 * @param query - parsed locator request.
 * @returns up to `query.limit` matches, visible ones first, in document order.
 */
export function findElements(query: LocatorQuery): FoundElement[] {
  const limit = query.limit ?? DEFAULT_LIMIT
  const found: FoundElement[] = []
  for (const el of dedupeNested(candidates(query))) {
    const visible = isRendered(el)
    if (!visible && query.includeHidden !== true) continue
    const rect = el.getBoundingClientRect()
    found.push({
      element: el,
      selector: uniqueSelectorFor(el),
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      visible,
      editable: isEditableElement(el),
      focusable: isFocusableElement(el),
      label: accessibleName(el),
      role: roleOfElement(el),
    })
  }
  // The page may render an off-screen control first; what the user can see is
  // the likelier target, and document order is stable within each group.
  found.sort((left, right) => Number(right.visible) - Number(left.visible))
  return found.slice(0, limit)
}

/** Build the model-facing query result text. */
export function renderFound(found: FoundElement[], query: LocatorQuery, indexOf: (el: Element) => number | undefined): string {
  const description = query.selector !== undefined
    ? `selector "${query.selector}"`
    : query.text !== undefined
      ? `text "${query.text}"`
      : `role "${query.role ?? ''}"`
  if (found.length === 0) {
    return `No elements matched ${description}. Call browser_snapshot without query for the page inventory, or loosen includeHidden.`
  }
  const lines = [`Found ${found.length} element(s) matching ${description}:`]
  for (const item of found) {
    const index = indexOf(item.element)
    const identity = index === undefined ? '-' : `[${index}]`
    const state = [
      item.visible ? undefined : 'hidden',
      item.editable ? 'editable' : undefined,
      item.focusable ? 'focusable' : undefined,
    ].filter((value) => value !== undefined).join('/')
    const label = item.label.length > LABEL_MAX_CHARS ? `${item.label.slice(0, LABEL_MAX_CHARS - 1)}…` : item.label
    const rect = `${Math.round(item.rect.x)},${Math.round(item.rect.y)} ${Math.round(item.rect.width)}x${Math.round(item.rect.height)}`
    lines.push(`  ${identity} ${item.role} "${label}" · selector=${item.selector} · rect=${rect}${state === '' ? '' : ` · ${state}`}`)
  }
  lines.push('Click by index when one is present, otherwise by selector; use rect center with browser_click { point } for a raw mouse click.')
  return lines.join('\n')
}
