// @vitest-environment jsdom

/**
 * Sending a prompt after scrolling up must bring the new turn into view.
 *
 * The follow-bottom latch (`atBottomRef`) is what decides whether new rows
 * scroll into view. It is deliberately cleared when the reader scrolls away from
 * the bottom, so the panel never yanks them while they are reading history —
 * but sending a prompt is an explicit "I am done reading", and must re-arm it.
 * Before this, a reader who scrolled up and then sent a message stayed parked
 * while the answer streamed in below the fold.
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

const CONTENT_HEIGHT = 2000
const VIEWPORT_HEIGHT = 600

describe('sending re-arms follow-bottom', () => {
  let root: Root
  let onStatus: ((state: 'connected', caps: null) => void) | undefined
  let onResumeHint: ((sessionId: string | null) => void) | undefined
  let onEvent: ((event: unknown) => void) | undefined
  let rpc: Mock<(method: string, payload?: unknown) => Promise<unknown>>
  let scrollTop: number
  let scrollWrites: number[]

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    scrollTop = 0
    scrollWrites = []

    const clamp = (value: number): number => Math.max(0, Math.min(value, CONTENT_HEIGHT - VIEWPORT_HEIGHT))
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get(this: HTMLElement) { return this.classList.contains('messages') ? CONTENT_HEIGHT : 0 },
    })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get(this: HTMLElement) { return this.classList.contains('messages') ? VIEWPORT_HEIGHT : 0 },
    })
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get(this: HTMLElement) { return this.classList.contains('messages') ? scrollTop : 0 },
      set(this: HTMLElement, value: number) {
        if (!this.classList.contains('messages')) return
        scrollTop = clamp(value)
        scrollWrites.push(scrollTop)
      },
    })
    HTMLElement.prototype.scrollTo = function scrollTo(this: HTMLElement, options?: ScrollToOptions | number) {
      const top = typeof options === 'number' ? options : options?.top ?? 0
      if (!this.classList.contains('messages')) return
      scrollTop = clamp(top)
      scrollWrites.push(scrollTop)
    } as typeof HTMLElement.prototype.scrollTo

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
        return {
          events: Array.from({ length: 10 }, (_, index) => ({
            type: 'message',
            role: index % 2 === 0 ? 'user' : 'assistant',
            content: [{ type: 'text', text: `Row ${index} — enough text to give the pane some height.` }],
          })),
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
      if (method === 'commands.list') return { provisional: true, commands: [] }
      if (method === 'skills.list') return { provisional: true, skills: [] }
      throw new Error(`unexpected RPC: ${method}`)
    })

    const unsubscribe = (): void => {}
    panelApi = {
      rpc: async <T = unknown>(method: string, payload?: unknown): Promise<T> =>
        await rpc(method, payload) as T,
      respond: vi.fn(async () => undefined),
      onStatus: vi.fn((callback) => { onStatus = callback as typeof onStatus; return unsubscribe }),
      onEvent: vi.fn((callback) => { onEvent = callback as typeof onEvent; return unsubscribe }),
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
    })
  }

  function transcript(): HTMLElement | null {
    return document.querySelector<HTMLElement>('.messages')
  }

  async function scrollToOffset(offset: number): Promise<void> {
    scrollTop = offset
    await act(async () => {
      transcript()!.dispatchEvent(new Event('scroll'))
    })
  }

  async function typeAndSend(text: string): Promise<void> {
    const box = document.querySelector<HTMLTextAreaElement>('.composer-box textarea')!
    // React tracks the DOM value through its own setter, so assigning `.value`
    // directly leaves `onChange` blind to the change.
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    await act(async () => {
      setter?.call(box, text)
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
    // Enter is the composer's own submit path: no form wraps it.
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await vi.waitFor(() => {
      expect(rpc.mock.calls.some(([method]) => method === 'session.prompt')).toBe(true)
    })
  }

  it('scrolls the new turn into view after the reader had scrolled up', async () => {
    await renderConnected()

    // The reader scrolls into the middle of the transcript.
    await scrollToOffset(400)
    expect(scrollTop).toBe(400)
    scrollWrites = []

    await typeAndSend('a fresh question')

    // The latch must be re-armed and the viewport moved to the newest row.
    expect(scrollWrites.length).toBeGreaterThan(0)
    expect(scrollTop).toBe(CONTENT_HEIGHT - VIEWPORT_HEIGHT)
  })

  it('keeps following the bottom while the reader was already there', async () => {
    await renderConnected()
    await scrollToOffset(CONTENT_HEIGHT - VIEWPORT_HEIGHT)
    scrollWrites = []

    await typeAndSend('another question')

    expect(scrollTop).toBe(CONTENT_HEIGHT - VIEWPORT_HEIGHT)
  })
})
