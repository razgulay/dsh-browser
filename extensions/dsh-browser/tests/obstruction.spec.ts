// @vitest-environment jsdom

/**
 * Detecting what covers the page.
 *
 * jsdom has no hit-testing, so each test installs `elementFromPoint` itself.
 * That is honest here: the detector's whole job is to interpret hit-testing
 * results, and the scoring is what these cases are about.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { detectObstruction, renderObstruction } from '../src/content/obstruction.ts'

/** What `elementFromPoint` should answer, and the viewport size. */
let hitTarget: Element | null = null

beforeEach(() => {
  document.body.innerHTML = ''
  hitTarget = null
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: () => hitTarget,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** Give an element a box, since jsdom reports zero for everything. */
function withRect(element: Element, rect: { width: number; height: number; top?: number }): Element {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: 0,
      y: rect.top ?? 0,
      top: rect.top ?? 0,
      left: 0,
      width: rect.width,
      height: rect.height,
      right: rect.width,
      bottom: (rect.top ?? 0) + rect.height,
      toJSON: () => ({}),
    }),
  })
  return element
}

describe('detectObstruction', () => {
  it('reports a consent gate that covers the page', () => {
    document.body.innerHTML = `
      <div id="cookie-consent" role="dialog" aria-modal="true">
        <h2>We value your privacy</h2>
        <button>Accept all</button>
      </div>
    `
    const gate = withRect(document.getElementById('cookie-consent')!, { width: 1000, height: 800 })
    Object.assign((gate as HTMLElement).style, {
      position: 'fixed', inset: '0', zIndex: '2147483000',
    })
    hitTarget = gate

    const found = detectObstruction(document)
    expect(found).toBeDefined()
    expect(found!.blocking).toBe(true)
    expect(found!.coverage).toBe(1)
    // The label is what a person would call it, not a CSS path.
    expect(found!.label).toBe('We value your privacy')
    expect(found!.selector).toBe('#cookie-consent')
  })

  it('ignores an ordinary sticky header that covers little of the page', () => {
    // A 1000×60 header is 7.5% of the viewport: a tooltip-sized layer, not a gate.
    document.body.innerHTML = '<header id="masthead"><nav>menu</nav></header>'
    const header = withRect(document.getElementById('masthead')!, { width: 1000, height: 60 })
    Object.assign((header as HTMLElement).style, { position: 'sticky', top: '0' })
    hitTarget = header

    expect(detectObstruction(document)).toBeUndefined()
  })

  it('reports a large overlay as non-blocking when nothing says it is modal', () => {
    // Big enough to cover a third of the screen, but it declares nothing and
    // holds no focus: the model should be told it is there, not that it blocks.
    document.body.innerHTML = `
      <div id="promo"><p>Spring sale</p></div>
    `
    const promo = withRect(document.getElementById('promo')!, { width: 1000, height: 400 })
    Object.assign((promo as HTMLElement).style, { position: 'fixed' })
    hitTarget = promo

    const found = detectObstruction(document)
    expect(found).toBeDefined()
    expect(found!.blocking).toBe(false)
    expect(found!.coverage).toBe(0.5)
  })

  it('ignores a fixed layer that is not rendered in place', () => {
    document.body.innerHTML = '<div id="ghost" role="dialog" aria-modal="true">gone</div>'
    const ghost = withRect(document.getElementById('ghost')!, { width: 1000, height: 800 })
    Object.assign((ghost as HTMLElement).style, { position: 'fixed', visibility: 'hidden' })
    hitTarget = ghost

    expect(detectObstruction(document)).toBeUndefined()
  })

  it('ignores a click-through layer', () => {
    // `pointer-events: none` means a click passes straight through, so such a
    // layer can never explain a click that did not land.
    document.body.innerHTML = '<div id="veil" role="dialog" aria-modal="true">veil</div>'
    const veil = withRect(document.getElementById('veil')!, { width: 1000, height: 800 })
    Object.assign((veil as HTMLElement).style, { position: 'fixed', pointerEvents: 'none' })
    hitTarget = veil

    expect(detectObstruction(document)).toBeUndefined()
  })

  it('stays silent when hit-testing is unavailable', () => {
    // A document that is not rendered must not make every snapshot throw.
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: undefined })
    document.body.innerHTML = '<div id="x">x</div>'
    expect(detectObstruction(document)).toBeUndefined()
  })

  it('picks the higher-scoring candidate when two layers overlap', () => {
    document.body.innerHTML = `
      <div id="backdrop"></div>
      <div id="login-dialog" role="alertdialog" aria-modal="true"><h2>Sign in to continue</h2></div>
    `
    // 700×500 of a 1000×800 viewport = 43.75%, above the one-third floor that
    // keeps tooltips out of the report.
    const dialog = withRect(document.getElementById('login-dialog')!, { width: 700, height: 500 })
    Object.assign((dialog as HTMLElement).style, { position: 'fixed', zIndex: '1000' })
    hitTarget = dialog

    const found = detectObstruction(document)
    expect(found?.selector).toBe('#login-dialog')
    expect(found?.blocking).toBe(true)
  })
})

describe('renderObstruction', () => {
  it('says clicks will not land when the overlay blocks', () => {
    const line = renderObstruction({
      selector: '#cookie-consent', label: 'We value your privacy', coverage: 0.87, blocking: true,
    })
    expect(line).toContain('Blocking overlay: #cookie-consent')
    expect(line).toContain('covers 87% of the viewport')
    expect(line).toContain('will not land')
  })

  it('does not claim blocking for a non-blocking overlay', () => {
    const line = renderObstruction({
      selector: '#promo', label: 'Spring sale', coverage: 0.5, blocking: false,
    })
    expect(line).toContain('Overlay: #promo')
    expect(line).not.toContain('will not land')
  })

  it('renders nothing when nothing was found', () => {
    expect(renderObstruction(undefined)).toBeUndefined()
  })
})
