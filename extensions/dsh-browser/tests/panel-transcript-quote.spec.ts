// @vitest-environment jsdom

/**
 * Quoting the transcript from the panel: highlight text inside the message
 * list, the composer offers "Quote text", and the attachment reaches the prompt
 * fenced and attributed rather than pasted in as ordinary words.
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { PanelApi } from '../src/panel/api.ts'

let panelApi: PanelApi

vi.mock('../src/panel/api.ts', () => ({
  connectPanel: (): PanelApi => panelApi,
}))

import { App } from '../src/panel/App.tsx'

const QUOTED = 'Bug tiep, khi toi keo len tren'

/** Point `window.getSelection` at a range the panel can see as a highlight. */
function selectInside(element: Element, text: string): void {
  const range = document.createRange()
  range.selectNodeContents(element)
  // jsdom has no layout engine and Range has no rect at all, so the panel's
  // anchoring read would throw. Give every highlight a plausible box.
  Object.defineProperty(range, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ top: 400, left: 120, width: 200, height: 20, right: 320, bottom: 420, x: 120, y: 400 }),
  })
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  // jsdom does not derive `toString()` from the range, so shadow the value the
  // panel actually reads. Anchoring still comes from the real range above.
  Object.defineProperty(selection, 'toString', { configurable: true, value: () => text })
}

describe('quoting the conversation', () => {
  let root: Root
  let onStatus: ((state: 'connected', caps: null) => void) | undefined
  let onResumeHint: ((sessionId: string | null) => void) | undefined
  let rpc: Mock<(method: string, payload?: unknown) => Promise<unknown>>

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    HTMLElement.prototype.scrollTo = vi.fn()
    vi.stubGlobal('chrome', {
      storage: { local: { get: vi.fn(async () => ({ dshSettings: { autoResumeSession: false } })) } },
      windows: { getCurrent: vi.fn(async () => ({ id: 1 })) },
      runtime: {
        getManifest: vi.fn(() => ({ version: '0.1.9' })),
        getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
        sendMessage: vi.fn(async () => undefined),
      },
    })

    rpc = vi.fn(async (method: string) => {
      if (method === 'session.create') return { sessionId: 'session-current' }
      if (method === 'session.history') {
        // The Host wraps each entry; the panel maps `entry.event`.
        return {
          events: [
            {
              event: {
                type: 'user/message',
                data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'initial question' }] } },
              },
            },
            {
              event: {
                type: 'assistant/message',
                data: { message: { content: [{ type: 'text', text: QUOTED }] } },
              },
            },
          ],
        }
      }
      if (method === 'session.prompt') return { ok: true }
      if (method === 'session.list') return { items: [] }
      if (method === 'session.models') {
        return {
          current: { provider: 'provider', model: 'saved-model' },
          routable: true,
          groups: [{ id: 'provider', name: 'Provider', models: [{ id: 'saved-model', name: 'Saved model' }] }],
        }
      }
      if (method === 'session.permissions') {
        return {
          current: 'workspace-write',
          defaultPreset: 'workspace-write',
          routable: true,
          provisional: false,
          options: [{ value: 'workspace-write', name: 'Workspace edits' }],
        }
      }
      if (method === 'settings.get') return { settings: {} }
      if (method === 'commands.list') {
        // A known Host command, so the composer classifies the line as a
        // command and reaches the attachment check instead of refusing it as
        // an unknown slash line.
        return {
          provisional: false,
          commands: [{ name: 'compact', description: 'Compact the conversation' }],
        }
      }
      if (method === 'skills.list') return { provisional: true, skills: [] }
      throw new Error(`unexpected RPC: ${method}`)
    })

    const unsubscribe = (): void => {}
    panelApi = {
      rpc: async <T = unknown>(method: string, payload?: unknown): Promise<T> =>
        await rpc(method, payload) as T,
      respond: vi.fn(async () => undefined),
      onStatus: vi.fn((callback) => { onStatus = callback as typeof onStatus; return unsubscribe }),
      onEvent: vi.fn(() => unsubscribe),
      onApprovalRequest: vi.fn(() => unsubscribe),
      onApprovalResolved: vi.fn(() => unsubscribe),
      onTabAffinity: vi.fn(() => unsubscribe),
      onSelection: vi.fn(() => unsubscribe),
      onSessionResumeHint: vi.fn((callback) => { onResumeHint = callback as typeof onResumeHint; return unsubscribe }),
      respondToApproval: vi.fn(async () => {}),
      resolveTabAffinity: vi.fn(async () => {}),
      rebindTabAffinity: vi.fn(async () => {}),
      returnToControlledTab: vi.fn(async () => {}),
      clearSelection: vi.fn(async () => {}),
      registerWindow: vi.fn(async () => {}),
      setActiveSession: vi.fn(async () => {}),
      updateSettings: vi.fn(async () => {}),
      onDevToolsStatus: vi.fn(() => unsubscribe),
      detachDevTools: vi.fn(async () => undefined),
      captureScreenshot: vi.fn(async () => ({ data: '', mediaType: 'image/png', width: 1, height: 1 })),
      startPicker: vi.fn(async () => undefined),
      cancelPicker: vi.fn(async () => undefined),
      onPickResult: vi.fn(() => () => {}),
      requestStatus: vi.fn(async () => {}),
      startDiscovery: vi.fn(async () => []),
      cancelDiscovery: vi.fn(async () => {}),
      onDiscoveryProgress: vi.fn(() => unsubscribe),
    }
    root = createRoot(document.querySelector('#root')!)
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  async function renderConnected(): Promise<void> {
    await act(async () => { root.render(createElement(App)) })
    await act(async () => {
      onStatus?.('connected', null)
      onResumeHint?.(null)
    })
    await vi.waitFor(() => {
      expect(rpc.mock.calls.some(([method]) => method === 'session.permissions')).toBe(true)
      expect(document.querySelector('.messages .row.assistant')).not.toBeNull()
    })
  }

  /** Simulate the end of a drag inside the transcript. */
  async function highlightInTranscript(text: string): Promise<void> {
    const transcript = document.querySelector<HTMLElement>('.messages')!
    selectInside(transcript, text)
    await act(async () => {
      document.dispatchEvent(new Event('mouseup', { bubbles: true }))
    })
  }

  function offer(): HTMLButtonElement | null {
    return document.querySelector<HTMLButtonElement>('.quote-offer')
  }

  async function typeAndSubmit(text: string): Promise<void> {
    const box = document.querySelector<HTMLTextAreaElement>('.composer-box textarea')!
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    await act(async () => {
      setter?.call(box, text)
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
  }

  it('offers to quote a highlight that lives in the transcript', async () => {
    await renderConnected()
    expect(offer()).toBeNull()

    await highlightInTranscript(QUOTED)

    await vi.waitFor(() => { expect(offer()).not.toBeNull() })
    expect(offer()!.textContent).toContain('Quote text')
    // The button belongs to the highlight, not to the composer: it floats.
    expect(offer()!.closest('.composer-box')).toBeNull()
    // And it lives inside the scroller, so it travels with the text rather
    // than staying pinned to the viewport while the passage scrolls away.
    expect(offer()!.parentElement?.classList.contains('messages')).toBe(true)
  })

  it('positions the offer at the highlight it acts on', async () => {
    await renderConnected()
    await highlightInTranscript(QUOTED)

    await vi.waitFor(() => { expect(offer()).not.toBeNull() })
    // jsdom reports a zero-origin frame and no scroll, so the transcript-space
    // offset equals the range top; the button sits one line above it.
    expect(offer()!.style.top).toBe('368px')
    expect(offer()!.style.left).toBe('120px')
  })

  it('converts the highlight rect into transcript space, so scrolling keeps them together', async () => {
    await renderConnected()

    const transcript = document.querySelector<HTMLElement>('.messages')!
    // Pretend the transcript starts 100px down the viewport and is scrolled 500px.
    Object.defineProperty(transcript, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 100, left: 10, width: 360, height: 600, right: 370, bottom: 700, x: 10, y: 100 }),
    })
    Object.defineProperty(transcript, 'scrollTop', { configurable: true, get: () => 500, set: () => {} })

    await highlightInTranscript(QUOTED)

    await vi.waitFor(() => { expect(offer()).not.toBeNull() })
    // 400 - 100 + 500 = 800 in transcript space, minus the 32px offset.
    expect(offer()!.style.top).toBe('768px')
    // 120 - 10 = 110.
    expect(offer()!.style.left).toBe('110px')
  })

  it('ignores a highlight outside the transcript', async () => {
    await renderConnected()

    // The topbar is selectable too, and must not become a quote.
    const outside = document.querySelector<HTMLElement>('.topbar')!
    selectInside(outside, 'Connected')
    await act(async () => {
      document.dispatchEvent(new Event('mouseup', { bubbles: true }))
    })

    await act(async () => { await Promise.resolve() })
    expect(offer()).toBeNull()
  })

  it('dismisses the offer on a press elsewhere even when the selection survives', async () => {
    await renderConnected()
    await highlightInTranscript(QUOTED)
    await vi.waitFor(() => { expect(offer()).not.toBeNull() })

    // Chrome does not always collapse a document selection when the click lands
    // on a non-editable area. Leave the range intact and press elsewhere: the
    // offer must go anyway. This is the "sometimes it lingers" report.
    await act(async () => {
      document.querySelector('.composer-box')!.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, cancelable: true }),
      )
    })

    await vi.waitFor(() => { expect(offer()).toBeNull() })
  })

  it('keeps the offer when the press is on the offer itself', async () => {
    await renderConnected()
    await highlightInTranscript(QUOTED)
    await vi.waitFor(() => { expect(offer()).not.toBeNull() })

    await act(async () => {
      offer()!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
    })

    // The click that follows must still find its button.
    await act(async () => { await Promise.resolve() })
    expect(offer()).not.toBeNull()
  })

  it('dismisses the offer when the selection collapses', async () => {
    await renderConnected()
    await highlightInTranscript(QUOTED)
    await vi.waitFor(() => { expect(offer()).not.toBeNull() })

    await act(async () => {
      window.getSelection()?.removeAllRanges()
      document.dispatchEvent(new Event('selectionchange'))
    })

    await vi.waitFor(() => { expect(offer()).toBeNull() })
  })

  it('attaches the quote to the composer, then removes it', async () => {
    await renderConnected()
    await highlightInTranscript(QUOTED)
    await vi.waitFor(() => { expect(offer()).not.toBeNull() })

    await act(async () => { offer()!.click() })

    await vi.waitFor(() => { expect(document.querySelector('.transcript-quote')).not.toBeNull() })
    expect(document.querySelector('.quote-offer')).toBeNull()
    expect(document.querySelector('.transcript-quote .page-selection-quote')?.textContent)
      .toContain('Bug tiep')

    const remove = document.querySelector<HTMLButtonElement>('.transcript-quote .page-selection-chip > button')!
    await act(async () => { remove.click() })
    await vi.waitFor(() => { expect(document.querySelector('.transcript-quote')).toBeNull() })
  })

  it('sends the quote fenced and attributed, with the question outside the fence', async () => {
    await renderConnected()
    await highlightInTranscript(QUOTED)
    await vi.waitFor(() => { expect(offer()).not.toBeNull() })
    await act(async () => { offer()!.click() })
    await vi.waitFor(() => { expect(document.querySelector('.transcript-quote')).not.toBeNull() })

    await typeAndSubmit('giai thich cho nay')
    await vi.waitFor(() => {
      expect(rpc.mock.calls.some(([method]) => method === 'session.prompt')).toBe(true)
    })

    const call = rpc.mock.calls.find(([method]) => method === 'session.prompt')!
    const sent = JSON.stringify(call[1])
    expect(sent).toContain('QUOTED_TRANSCRIPT')
    expect(sent).toContain('Bug tiep')
    // The ask must sit after the closing marker, never inside the quote.
    expect(sent).toContain('</QUOTED_TRANSCRIPT>\\n\\ngiai thich cho nay')
    // And the attachment is consumed, not left for the next message.
    await vi.waitFor(() => { expect(document.querySelector('.transcript-quote')).toBeNull() })
  })

  it('refuses to send a command with a quote attached', async () => {
    await renderConnected()
    await highlightInTranscript(QUOTED)
    await vi.waitFor(() => { expect(offer()).not.toBeNull() })
    await act(async () => { offer()!.click() })
    await vi.waitFor(() => { expect(document.querySelector('.transcript-quote')).not.toBeNull() })

    await typeAndSubmit('/compact')
    // Typing a `/` line opens the slash menu, which owns Enter to accept its
    // highlighted row. Escape closes the menu so the next Enter submits the
    // draft — the same two steps a person performs.
    await act(async () => {
      const box = document.querySelector<HTMLTextAreaElement>('.composer-box textarea')!
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await act(async () => {
      const box = document.querySelector<HTMLTextAreaElement>('.composer-box textarea')!
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    await vi.waitFor(() => {
      expect(document.querySelector('.error')?.textContent ?? '').toContain('quoted text')
    })
    // The attachment survives the refusal: the user's draft was not consumed.
    expect(document.querySelector('.transcript-quote')).not.toBeNull()
  })
})
