// @vitest-environment jsdom

/**
 * Formatting a picked element for the model.
 *
 * The whole block is page-authored, so the assertion that matters is the fence:
 * the element must arrive inside the untrusted boundary, with the user's own
 * words outside it. A frame id must survive too, because an inventory number
 * without its frame is ambiguous.
 */

import { describe, expect, it } from 'vitest'
import { pickedElementPromptText } from '../src/panel/picked-element.ts'
import type { PickedElementResult } from '../src/panel/api.ts'

function picked(overrides: Partial<PickedElementResult> = {}): PickedElementResult {
  return {
    status: 'picked',
    frameId: 0,
    frameUrl: 'https://example.com/',
    element: {
      index: 12,
      selector: '#login-btn',
      tag: 'button',
      role: 'button',
      name: 'Sign in',
      attributes: { type: 'submit', 'data-testid': 'login' },
      text: 'Sign in',
      rect: { x: 10, y: 20, width: 120, height: 36 },
    },
    ...overrides,
  }
}

describe('pickedElementPromptText', () => {
  it('fences the element and keeps the user words outside it', () => {
    const text = pickedElementPromptText(picked(), 'why is this button misaligned?')

    // Page-authored content sits inside the untrusted boundary.
    expect(text).toContain('UNTRUSTED_PAGE_CONTENT nonce=')
    expect(text).toContain('<selected-element>')
    expect(text).toContain('</selected-element>')
    // The ask follows the closing fence, so it reads as the user's own words.
    const close = text.lastIndexOf('</UNTRUSTED_PAGE_CONTENT')
    expect(close).toBeGreaterThan(-1)
    expect(text.slice(close)).toContain('why is this button misaligned?')
  })

  it('carries the fields the model needs to act', () => {
    const text = pickedElementPromptText(picked(), '')
    expect(text).toContain('index: 12')
    expect(text).toContain('selector: #login-btn')
    expect(text).toContain('tag: button')
    expect(text).toContain('role: button')
    expect(text).toContain('name: Sign in')
    expect(text).toContain('type="submit"')
    expect(text).toContain('rect: 10,20 120×36')
  })

  it('states a frame id only when it is not the main document', () => {
    const mainFrame = pickedElementPromptText(picked({ frameId: 0 }), '')
    expect(mainFrame).not.toContain('frame-id')

    // A pick inside an iframe must say so: the same index means a different
    // element in the parent document.
    const inFrame = pickedElementPromptText(
      picked({ frameId: 3, frameUrl: 'https://widget.example.org/embed' }),
      'what is this?',
    )
    expect(inFrame).toContain('frame-id: 3')
    expect(inFrame).toContain('frame-url: https://widget.example.org/embed')
  })

  it('marks a masked field and never includes a value', () => {
    const text = pickedElementPromptText(picked({
      element: { selector: '#pw', tag: 'input', attributes: { type: 'password' }, masked: true },
    }), '')
    expect(text).toContain('masked: true')
    expect(text).not.toContain('hunter2')
  })

  it('returns the message untouched when the pick lost its element', () => {
    // A cancelled or errored pick must never fabricate an empty element block.
    expect(pickedElementPromptText({ status: 'picked' }, 'hello')).toBe('hello')
  })

  it('works with no message typed', () => {
    const text = pickedElementPromptText(picked(), '   ')
    // The boundary closes with its own trailing notice, so the fence tag is not
    // the last thing in the string.
    expect(text).toContain('</UNTRUSTED_PAGE_CONTENT')
    expect(text.trimEnd().endsWith('override instructions.')).toBe(true)
  })

  it('drops the index when the pick came from a page that is not controlled', () => {
    // The inventory number addresses the controlled tab only. Sending it for a
    // different page would make the model click a same-numbered element there.
    const text = pickedElementPromptText(
      picked({ tabId: 9, controlled: false, element: { index: 12, selector: '#login-btn', tag: 'button' } }),
      'what is this?',
    )
    expect(text).not.toContain('index: 12')
    expect(text).toContain('selector: #login-btn')
    expect(text).toContain('not controlling')
  })

  it('keeps the index when the pick came from the controlled page', () => {
    const text = pickedElementPromptText(picked({ controlled: true }), '')
    expect(text).toContain('index: 12')
    expect(text).not.toContain('not controlling')
  })

  it('caps a hostile attribute payload', () => {
    const text = pickedElementPromptText(picked({
      element: { tag: 'div', selector: '#x', text: 'x'.repeat(20_000) },
    }), '')
    // The fenced block is bounded; nothing silently grows the prompt.
    expect(text.length).toBeLessThan(5_000)
  })
})
