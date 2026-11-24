// @vitest-environment jsdom

/**
 * Element picker, content side.
 *
 * The safety properties matter more than the happy path here: a pick must never
 * reach the page's own handlers, must never carry a form value or a sensitive
 * field's text, and must end on Escape or navigation rather than leaving an
 * overlay behind.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ElementPickerSession,
  describeElement,
  type PickedElement,
  type PickerEnd,
} from '../src/content/picker.ts'

/** jsdom has no hit-testing, so tests install the element `elementsFromPoint` should return. */
let hitStack: Element[] = []

/** Sessions armed during a test, disarmed afterwards so listeners never leak. */
const armed: ElementPickerSession[] = []

function makeSession(indexOf: (el: Element) => number | undefined = () => undefined) {
  const picks: PickedElement[] = []
  const ends: PickerEnd[] = []
  const session = new ElementPickerSession(
    { onPick: (element) => picks.push(element), onEnd: (reason) => ends.push(reason) },
    indexOf,
  )
  armed.push(session)
  return { session, picks, ends }
}

beforeEach(() => {
  document.body.innerHTML = ''
  // The host is appended to `documentElement`, not to `body`, so a previous
  // test's overlay would otherwise survive into this one and keep its window
  // listeners — which is exactly how a stray Escape listener makes a later
  // "reports nothing at rest" assertion fail.
  document.getElementById('__dsh_picker_host')?.remove()
  document.getElementById('__dsh_picker_cursor')?.remove()
  document.documentElement.style.removeProperty('cursor')
  hitStack = []
  Object.defineProperty(document, 'elementsFromPoint', {
    configurable: true,
    value: () => hitStack,
  })
})

afterEach(() => {
  // A session left armed keeps a capture-phase Escape listener that swallows the
  // next test's event, so every session is disarmed before the DOM is cleaned.
  for (const session of armed.splice(0)) session.setEnabled(false, Number.MAX_SAFE_INTEGER, 'cleanup')
  vi.restoreAllMocks()
})


describe('session arming', () => {
  it('mounts an overlay host and a cursor override, then removes both', () => {
    const { session } = makeSession()
    expect(document.getElementById('__dsh_picker_host')).toBeNull()

    expect(session.setEnabled(true, 1, 'epoch-a')).toBe(true)
    expect(session.active).toBe(true)
    expect(document.getElementById('__dsh_picker_host')).not.toBeNull()
    // The root's inline cursor is what actually beats a page's `!important`.
    expect(document.documentElement.style.getPropertyValue('cursor')).toBe('crosshair')

    expect(session.setEnabled(false, 2, 'epoch-a')).toBe(true)
    expect(session.active).toBe(false)
    expect(document.getElementById('__dsh_picker_host')).toBeNull()
    expect(document.documentElement.style.getPropertyValue('cursor')).toBe('')
  })

  it('ignores a stale command from the same worker lifetime', () => {
    const { session } = makeSession()
    session.setEnabled(true, 5, 'epoch-a')

    // A disarm carrying an older revision must not win over the newer arm.
    expect(session.setEnabled(false, 4, 'epoch-a')).toBe(false)
    expect(session.active).toBe(true)
  })

  it('accepts a command from a new worker lifetime even with a lower revision', () => {
    const { session } = makeSession()
    session.setEnabled(true, 9, 'epoch-a')

    // A restarted worker restarts its revision counter.
    expect(session.setEnabled(false, 0, 'epoch-b')).toBe(true)
    expect(session.active).toBe(false)
  })

  it('does not mount twice across an arm/disarm/arm cycle', () => {
    const { session } = makeSession()
    session.setEnabled(true, 1, 'a')
    session.setEnabled(false, 2, 'a')
    session.setEnabled(true, 3, 'a')
    // Re-arming must produce exactly one overlay, not a second stacked one.
    expect(document.querySelectorAll('#__dsh_picker_host')).toHaveLength(1)
  })
})

describe('describeElement', () => {
  it('drops event handlers, inline style, and form values', () => {
    document.body.innerHTML = `
      <button id="go" onclick="steal()" style="color:red" value="secret" data-role="cta">Go</button>
    `
    const described = describeElement(document.getElementById('go')!)

    expect(described.tag).toBe('button')
    expect(described.selector).toBe('#go')
    expect(described.attributes).not.toHaveProperty('onclick')
    expect(described.attributes).not.toHaveProperty('style')
    expect(described.attributes).not.toHaveProperty('value')
    expect(described.attributes['data-role']).toBe('cta')
  })

  it('masks a sensitive field and withholds its text', () => {
    document.body.innerHTML = '<input id="pw" type="password" value="hunter2">'
    const described = describeElement(document.getElementById('pw')!)

    expect(described.masked).toBe(true)
    expect(JSON.stringify(described)).not.toContain('hunter2')
    expect(described.text).toBeUndefined()
  })

  it('caps a long attribute value and long text', () => {
    document.body.innerHTML = `<div id="long" title="${'t'.repeat(400)}">${'x'.repeat(500)}</div>`
    const described = describeElement(document.getElementById('long')!)

    // The cap includes the ellipsis: the reported value never exceeds the limit.
    expect(described.attributes.title!.length).toBeLessThanOrEqual(120)
    expect(described.attributes.title!.endsWith('…')).toBe(true)
    expect(described.text!.length).toBeLessThanOrEqual(201)
  })

  it('carries the inventory number when the element has one', () => {
    document.body.innerHTML = '<button id="b">Go</button>'
    const described = describeElement(document.getElementById('b')!, 7)
    expect(described.index).toBe(7)
  })
})

describe('session ending', () => {
  it('cancels on Escape and reports it once', () => {
    const { session, ends } = makeSession()
    session.setEnabled(true, 1, 'a')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    expect(ends).toEqual(['cancelled'])
    expect(session.active).toBe(false)
    expect(document.getElementById('__dsh_picker_host')).toBeNull()
  })

  it('does not report a cancel when no session is armed', () => {
    const { session, ends } = makeSession()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    // Escape at rest belongs to the page, not to the picker.
    expect(ends).toEqual([])
    expect(session.active).toBe(false)
  })

  it('tears down when the page is being hidden', () => {
    const { session, ends } = makeSession()
    session.setEnabled(true, 1, 'a')

    window.dispatchEvent(new Event('pagehide'))

    expect(ends).toEqual(['cancelled'])
    expect(document.getElementById('__dsh_picker_host')).toBeNull()
  })
})
