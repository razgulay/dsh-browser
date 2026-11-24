/**
 * Element picker: a click-to-select overlay for one frame.
 *
 * The user presses "pick element" in the panel, hovers the page, and clicks the
 * element they mean. The result travels back as an attachment so the model knows
 * exactly which part of the page the person is pointing at.
 *
 * Two design choices worth stating up front:
 *
 * - The overlay lives in a **closed shadow root** and blocks pointer events, so
 *   the page's own handlers never fire. There is no way for a pick to activate
 *   a link, submit a form, or dismiss the very dialog the user was aiming at.
 *   The element under the cursor is read with `elementsFromPoint` and the
 *   overlay itself is skipped, which avoids toggling `pointer-events` on and off
 *   and therefore avoids flicker.
 * - Every piece of returned data is treated as page-authored: attributes are
 *   filtered, `on*` handlers are dropped, input values are never included, and
 *   sensitive fields are masked through the same helpers the snapshot uses. The
 *   picker must not become a way around the snapshot's privacy boundary.
 *
 * @module
 */

import { accessibleName, truncate } from './extract.ts'
import { uniqueSelectorFor } from './find.ts'
import { isSensitiveField } from './privacy.ts'

/** Host element id, also used to recognise our own nodes during hit-testing. */
const HOST_ID = '__dsh_picker_host'
/** Attribute carrying the picker's own cursor override. */
const CURSOR_STYLE_ID = '__dsh_picker_cursor'

/** Attributes never sent to the model: handlers and inline payloads. */
const FORBIDDEN_ATTRIBUTE = /^(on|style$|srcdoc$|nonce$)/i
/** Attribute count/value caps, so one element cannot flood the attachment. */
const MAX_ATTRIBUTES = 12
const MAX_ATTRIBUTE_CHARS = 120
const MAX_TEXT_CHARS = 200

/** One picked element, ready to attach to a prompt. */
export interface PickedElement {
  /** Inventory number when the element is part of the interactive set. */
  index?: number
  selector: string
  tag: string
  role?: string
  name?: string
  attributes: Record<string, string>
  text?: string
  rect: { x: number; y: number; width: number; height: number }
  /** True when the element is a form field whose value was withheld. */
  masked?: boolean
}

/** Why a picker session ended without an element. */
export type PickerEnd = 'cancelled' | 'unavailable'

/** Callbacks a session reports through. */
export interface PickerHandlers {
  onPick: (element: PickedElement) => void
  onEnd: (reason: PickerEnd) => void
}

/**
 * Read one element into an attachment payload.
 *
 * Exported for tests and for the background's own fallback path: resolving an
 * element that a tool already holds should produce the same shape the picker
 * produces, or the model would see two dialects of the same thing.
 *
 * @param el - the element to describe.
 * @param index - its inventory number, when it has one.
 */
export function describeElement(el: Element, index?: number): PickedElement {
  const rect = el.getBoundingClientRect()
  const attributes: Record<string, string> = {}
  let count = 0
  for (const attribute of [...el.attributes]) {
    if (count >= MAX_ATTRIBUTES) break
    if (FORBIDDEN_ATTRIBUTE.test(attribute.name)) continue
    // A form field's value is user data, not markup.
    if (attribute.name === 'value') continue
    // Reserve one character for the ellipsis so the cap is the cap.
    attributes[attribute.name] = attribute.value.length > MAX_ATTRIBUTE_CHARS
      ? `${attribute.value.slice(0, MAX_ATTRIBUTE_CHARS - 1)}…`
      : attribute.value
    count += 1
  }

  const sensitive = isSensitiveField(el)
  if (sensitive) {
    // The tag and selector are still useful; the text is the secret.
    attributes.type = 'password'
  }

  const role = el.getAttribute('role') ?? undefined
  const name = accessibleName(el)
  const rawText = sensitive ? '' : (el.textContent ?? '')
  const text = rawText.trim() === ''
    ? undefined
    : truncate(rawText.replace(/\s+/g, ' ').trim(), MAX_TEXT_CHARS).text

  return {
    ...(index === undefined ? {} : { index }),
    selector: uniqueSelectorFor(el),
    tag: el.tagName.toLowerCase(),
    ...(role === undefined ? {} : { role }),
    ...(name === '' ? {} : { name }),
    attributes,
    ...(text === undefined ? {} : { text }),
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    ...(sensitive ? { masked: true } : {}),
  }
}

/** Pick the element under a viewport point, skipping the picker's own nodes. */
function elementAt(x: number, y: number): Element | undefined {
  for (const candidate of document.elementsFromPoint(x, y)) {
    if (candidate.closest(`#${HOST_ID}`) !== null) continue
    // The <html> and <body> roots are never what a person means; keep looking
    // so a click on empty space still reports something specific.
    if (candidate === document.documentElement || candidate === document.body) continue
    return candidate
  }
  return undefined
}

/**
 * One picker session for one frame.
 *
 * Mirrors `SelectionWatcher`'s arm/disarm contract on purpose: the background
 * arms every frame and the first frame to report ends the session, so the two
 * watchers must handle out-of-order commands the same way (`epoch` for a worker
 * restart, `revision` for ordering).
 */
export class ElementPickerSession {
  private enabled = false
  private epoch = 'legacy'
  private revision = -1
  private hovered: Element | null = null
  private host: HTMLDivElement | null = null
  private highlight: HTMLDivElement | null = null
  private label: HTMLDivElement | null = null
  private cursorStyle: HTMLStyleElement | null = null
  private previousCursor: string | null = null

  /**
   * @param handlers - where a pick or an end is reported.
   * @param indexOf - inventory lookup owned by the content entry; picked
   *   elements that are part of the interactive set carry their number so the
   *   model can act on them with `click { index }` without a second lookup.
   */
  constructor(
    private readonly handlers: PickerHandlers,
    private readonly indexOf: (el: Element) => number | undefined,
  ) {}

  /** Whether a session is currently armed in this frame. */
  get active(): boolean {
    return this.enabled
  }

  /**
   * Arm or disarm the session.
   *
   * @param next - arm when true.
   * @param revision - the background's command sequence.
   * @param epoch - the issuing worker's lifetime.
   * @returns true when the state actually changed.
   */
  setEnabled(next: boolean, revision = 0, epoch = 'legacy'): boolean {
    if (epoch === this.epoch && revision < this.revision) return false
    this.epoch = epoch
    this.revision = revision
    if (next === this.enabled) return false
    this.enabled = next
    if (next) this.mount()
    else this.unmount()
    return true
  }

  /** Report a cancel from inside the page (Escape, navigation, lost context). */
  cancel(): void {
    if (!this.enabled) return
    this.setEnabled(false, this.revision, this.epoch)
    this.handlers.onEnd('cancelled')
  }

  private mount(): void {
    if (this.host !== null) return
    const host = document.createElement('div')
    host.id = HOST_ID
    // `all: initial` keeps page rules from reaching the overlay; the enormous
    // z-index clears every page layer short of the browser's own UI.
    host.style.cssText = 'all:initial !important;position:fixed !important;inset:0 !important;'
      + 'pointer-events:auto !important;z-index:2147483647 !important;'
    const shadow = host.attachShadow({ mode: 'closed' })

    const style = document.createElement('style')
    style.textContent = `
      .overlay { position: fixed; inset: 0; pointer-events: auto; background: transparent; cursor: crosshair; }
      .highlight {
        position: fixed; pointer-events: none; z-index: 2;
        border: 2px solid #4d6bfe; background: rgba(77, 107, 254, 0.12);
        border-radius: 2px; transition: top .04s ease-out, left .04s ease-out, width .04s ease-out, height .04s ease-out;
      }
      .label {
        position: fixed; pointer-events: none; z-index: 3;
        max-width: 60vw; padding: 3px 7px; border-radius: 5px;
        background: #101828; color: #f2f5fb; font: 500 11px/1.4 -apple-system, "Segoe UI", sans-serif;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
    `
    const overlay = document.createElement('div')
    overlay.className = 'overlay'
    const highlight = document.createElement('div')
    highlight.className = 'highlight'
    highlight.style.display = 'none'
    const label = document.createElement('div')
    label.className = 'label'
    label.style.display = 'none'
    shadow.append(style, overlay, highlight, label)

    overlay.addEventListener('mousemove', this.onMove, true)
    overlay.addEventListener('click', this.onClick, true)
    overlay.addEventListener('mousedown', this.onSuppress, true)
    overlay.addEventListener('mouseup', this.onSuppress, true)
    overlay.addEventListener('contextmenu', this.onSuppress, true)
    // Capture-phase scroll blocking: the page must not move under the pointer
    // while the person is aiming at something.
    window.addEventListener('wheel', this.onSuppress, { capture: true, passive: false })
    window.addEventListener('keydown', this.onKeyDown, true)
    // A page that navigates away mid-pick would otherwise leave the overlay
    // mounted on whatever document replaced it.
    window.addEventListener('pagehide', this.onPageHide, true)

    document.documentElement.appendChild(host)
    this.host = host
    this.highlight = highlight
    this.label = label

    // Some pages pin `cursor` with `!important` on body or html; only an inline
    // override on the root element reliably wins.
    const style2 = document.createElement('style')
    style2.id = CURSOR_STYLE_ID
    style2.textContent = 'html, html *, html *::before, html *::after { cursor: crosshair !important; }'
    document.head.appendChild(style2)
    this.cursorStyle = style2
    this.previousCursor = document.documentElement.style.getPropertyValue('cursor')
    document.documentElement.style.setProperty('cursor', 'crosshair', 'important')
  }

  private unmount(): void {
    this.host?.remove()
    this.host = null
    this.highlight = null
    this.label = null
    this.hovered = null
    this.cursorStyle?.remove()
    this.cursorStyle = null
    if (this.previousCursor !== null) {
      if (this.previousCursor === '') document.documentElement.style.removeProperty('cursor')
      else document.documentElement.style.setProperty('cursor', this.previousCursor)
      this.previousCursor = null
    }
    window.removeEventListener('wheel', this.onSuppress, { capture: true })
    window.removeEventListener('keydown', this.onKeyDown, true)
    window.removeEventListener('pagehide', this.onPageHide, true)
  }

  private readonly onSuppress = (event: Event): void => {
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  private readonly onPageHide = (): void => {
    // The document is going away; nothing can be picked, and the background will
    // re-arm on the next page.
    this.setEnabled(false, this.revision, this.epoch)
    this.handlers.onEnd('cancelled')
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopImmediatePropagation()
    this.cancel()
  }

  private readonly onMove = (event: MouseEvent): void => {
    const target = elementAt(event.clientX, event.clientY)
    if (target === undefined) return
    this.hovered = target
    const rect = target.getBoundingClientRect()
    if (this.highlight !== null) {
      this.highlight.style.display = 'block'
      this.highlight.style.top = `${rect.top}px`
      this.highlight.style.left = `${rect.left}px`
      this.highlight.style.width = `${rect.width}px`
      this.highlight.style.height = `${rect.height}px`
    }
    if (this.label !== null) {
      const name = accessibleName(target)
      const text = `${target.tagName.toLowerCase()} ${Math.round(rect.width)}×${Math.round(rect.height)}`
        + (name === '' ? '' : ` — ${name}`)
      this.label.textContent = text.length > 80 ? `${text.slice(0, 80)}…` : text
      this.label.style.display = 'block'
      // Keep the label on screen when the pointer is near an edge.
      const top = rect.top > 28 ? rect.top - 26 : rect.bottom + 6
      const left = Math.min(Math.max(4, rect.left), Math.max(4, window.innerWidth - 220))
      this.label.style.top = `${top}px`
      this.label.style.left = `${left}px`
    }
  }

  private readonly onClick = (event: MouseEvent): void => {
    event.preventDefault()
    event.stopImmediatePropagation()
    const target = this.hovered ?? elementAt(event.clientX, event.clientY)
    if (target === undefined) return
    // Numbered when it is part of the interactive set; a plain paragraph simply
    // has no number and is addressed by selector instead.
    const described = describeElement(target, this.indexOf(target))
    this.setEnabled(false, this.revision, this.epoch)
    this.handlers.onPick(described)
  }
}
