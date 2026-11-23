// @vitest-environment jsdom

/**
 * Leaving the conversation for the settings view must not lose the reader's
 * place.
 *
 * Settings replace the whole panel, so the transcript element is destroyed and
 * its `scrollTop` goes with it; coming back mounted a fresh element at offset
 * zero, which read as "it jumped to the top". These cases pin the capture,
 * clamp and bottom-follow rules that make the return land correctly.
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

/** A transcript taller than its viewport, so scrolling is meaningful. */
let contentHeight = 2000
const VIEWPORT_HEIGHT = 600

describe('returning from settings keeps the scroll position', () => {
  let root: Root
  let onStatus: ((state: 'connected', caps: null) => void) | undefined
  let onResumeHint: ((sessionId: string | null) => void) | undefined
  let rpc: Mock<(method: string, payload?: unknown) => Promise<unknown>>
  /** Survives the unmount, exactly like the browser's own element state would not. */
  let lastScrollTop: number
  let scrollTopsSeen: number[]

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    lastScrollTop = 0
    scrollTopsSeen = []

    // jsdom has no layout: give the transcript a fixed virtual height and make
    // `scrollTo` record what the panel asked for.
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('messages') ? contentHeight : 0
      },
    })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('messages') ? VIEWPORT_HEIGHT : 0
      },
    })
    // A real scrollport clamps `scrollTop` to [0, scrollHeight - clientHeight].
    // The mock must too, or a test would "pass" on an offset no browser allows.
    const clamp = (value: number): number =>
      Math.max(0, Math.min(value, contentHeight - VIEWPORT_HEIGHT))
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('messages') ? lastScrollTop : 0
      },
      set(this: HTMLElement, value: number) {
        if (!this.classList.contains('messages')) return
        lastScrollTop = clamp(value)
        scrollTopsSeen.push(lastScrollTop)
      },
    })
    HTMLElement.prototype.scrollTo = function scrollTo(this: HTMLElement, options?: ScrollToOptions | number) {
      const top = typeof options === 'number' ? options : options?.top ?? 0
      if (this.classList.contains('messages')) {
        lastScrollTop = clamp(top)
        scrollTopsSeen.push(lastScrollTop)
      }
    } as typeof HTMLElement.prototype.scrollTo

    vi.stubGlobal('chrome', {
      storage: { local: { get: vi.fn(async () => ({ dshSettings: { autoResumeSession: false } })) } },
      windows: { getCurrent: vi.fn(async () => ({ id: 1 })) },
      // The settings view renders UpdateCard, which reads the live version.
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
          events: Array.from({ length: 12 }, (_, index) => ({
            type: 'message',
            role: index % 2 === 0 ? 'user' : 'assistant',
            content: [{ type: 'text', text: `Row ${index} â€” a line of conversation long enough to fill space.` }],
          })),
        }
      }
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

  async function openSettings(): Promise<void> {
    const trigger = document.querySelector<HTMLButtonElement>('.settings-trigger')!
    await act(async () => { trigger.click() })
    await vi.waitFor(() => { expect(document.querySelector('.settings')).not.toBeNull() })
  }

  async function goBack(): Promise<void> {
    const back = document.querySelector<HTMLButtonElement>('.settings-heading .icon-button')!
    await act(async () => { back.click() })
    await vi.waitFor(() => { expect(transcript()).not.toBeNull() })
  }

  it('comes back to the offset the reader left', async () => {
    await renderConnected()

    // The reader scrolls into the middle of the transcript.
    lastScrollTop = 900
    await act(async () => {
      transcript()!.dispatchEvent(new Event('scroll'))
    })

    await openSettings()
    // The transcript is gone while settings are up.
    expect(transcript()).toBeNull()
    scrollTopsSeen = []

    await goBack()

    // A fresh element is mounted at 0; the panel must move it back.
    expect(scrollTopsSeen.length).toBeGreaterThan(0)
    expect(lastScrollTop).toBe(900)
  })

  it('still follows the bottom when the reader was pinned there', async () => {
    await renderConnected()

    // Exactly at the bottom: max = 2000 - 600.
    lastScrollTop = contentHeight - VIEWPORT_HEIGHT
    await act(async () => {
      transcript()!.dispatchEvent(new Event('scroll'))
    })

    await openSettings()
    scrollTopsSeen = []
    await goBack()

    expect(lastScrollTop).toBe(contentHeight - VIEWPORT_HEIGHT)
  })

  it('clamps the saved offset when the content shrank while settings were open', async () => {
    await renderConnected()

    // Mid-transcript, so this is a real restore rather than bottom-follow.
    lastScrollTop = 900
    await act(async () => {
      transcript()!.dispatchEvent(new Event('scroll'))
    })

    await openSettings()
    // The stream settled and the transcript got shorter while settings were up.
    contentHeight = 1000
    await goBack()

    const max = contentHeight - VIEWPORT_HEIGHT
    expect(lastScrollTop).toBeLessThanOrEqual(max)
    expect(lastScrollTop).toBeGreaterThanOrEqual(0)
  })
})
