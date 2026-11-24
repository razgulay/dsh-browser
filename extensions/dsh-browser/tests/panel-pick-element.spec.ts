// @vitest-environment jsdom

/**
 * Picking an element from the panel: the toolbar button arms the picker, the
 * background reports a pick, the chip appears, and the prompt carries the
 * element fenced.
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { PanelApi, PickedElementResult } from '../src/panel/api.ts'

let panelApi: PanelApi

vi.mock('../src/panel/api.ts', () => ({
  connectPanel: (): PanelApi => panelApi,
}))

import { App } from '../src/panel/App.tsx'

describe('element picker in the composer', () => {
  let root: Root
  let onStatus: ((state: 'connected', caps: null) => void) | undefined
  let onResumeHint: ((sessionId: string | null) => void) | undefined
  let onPickResult: ((result: PickedElementResult) => void) | undefined
  let rpc: Mock<(method: string, payload?: unknown) => Promise<unknown>>
  let startPicker: Mock<PanelApi['startPicker']>
  let cancelPicker: Mock<PanelApi['cancelPicker']>

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

    startPicker = vi.fn(async () => undefined)
    cancelPicker = vi.fn(async () => undefined)

    rpc = vi.fn(async (method: string) => {
      if (method === 'session.create') return { sessionId: 'session-current' }
      if (method === 'session.history') {
        return {
          events: [],
          projections: {
            asOfSeq: -1,
            values: {
              imageLimits: {
                maxImageBytes: 5_000_000,
                maxImagesPerMessage: 4,
                maxMessageImageBytes: 20_000_000,
                maxImagePixels: 4_000_000,
                maxImageDimension: 4096,
                mediaTypes: ['image/png', 'image/jpeg'],
              },
            },
          },
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
      startPicker,
      cancelPicker,
      onPickResult: vi.fn((callback) => { onPickResult = callback; return unsubscribe }),
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

  function pickButton(): HTMLButtonElement {
    return document.querySelector<HTMLButtonElement>('.composer-actions button.pick-button')!
  }

  function chip(): HTMLElement | null {
    return document.querySelector<HTMLElement>('.picked-element')
  }

  it('arms the picker and shows the armed state', async () => {
    await renderConnected()
    expect(pickButton().getAttribute('aria-pressed')).toBe('false')

    await act(async () => { pickButton().click() })

    await vi.waitFor(() => { expect(startPicker).toHaveBeenCalledTimes(1) })
    await vi.waitFor(() => { expect(pickButton().getAttribute('aria-pressed')).toBe('true') })
    expect(pickButton().classList.contains('armed')).toBe(true)
  })

  it('cancels an armed picker from the same button', async () => {
    await renderConnected()
    await act(async () => { pickButton().click() })
    await vi.waitFor(() => { expect(pickButton().getAttribute('aria-pressed')).toBe('true') })

    await act(async () => { pickButton().click() })

    await vi.waitFor(() => { expect(cancelPicker).toHaveBeenCalledTimes(1) })
    await vi.waitFor(() => { expect(pickButton().getAttribute('aria-pressed')).toBe('false') })
  })

  it('shows a chip labelled by tag and name, with the selector in the tooltip', async () => {
    await renderConnected()
    await act(async () => { pickButton().click() })

    await act(async () => {
      onPickResult?.({
        status: 'picked',
        frameId: 0,
        frameUrl: 'https://example.com/',
        element: { tag: 'button', name: 'Sign in', selector: '#login-btn' },
      })
    })

    await vi.waitFor(() => { expect(chip()).not.toBeNull() })
    // A person recognises "button — Sign in" faster than a CSS path.
    expect(chip()!.textContent).toContain('button — Sign in')
    expect(chip()!.querySelector('.page-selection-source')?.getAttribute('title')).toBe('#login-btn')
  })

  it('sends the found element fenced, and consumes the attachment', async () => {
    await renderConnected()
    await act(async () => { pickButton().click() })
    await act(async () => {
      onPickResult?.({
        status: 'picked',
        frameId: 0,
        frameUrl: 'https://example.com/',
        element: { index: 4, tag: 'button', name: 'Sign in', selector: '#login-btn' },
      })
    })
    await vi.waitFor(() => { expect(chip()).not.toBeNull() })

    const box = document.querySelector<HTMLTextAreaElement>('.composer-box textarea')!
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    await act(async () => {
      setter?.call(box, 'why is this misaligned?')
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await vi.waitFor(() => {
      expect(rpc.mock.calls.some(([method]) => method === 'session.prompt')).toBe(true)
    })

    const call = rpc.mock.calls.find(([method]) => method === 'session.prompt')!
    const sent = JSON.stringify(call[1])
    expect(sent).toContain('<selected-element>')
    expect(sent).toContain('index: 4')
    expect(sent).toContain('#login-btn')
    expect(sent).toContain('UNTRUSTED_PAGE_CONTENT')
    // The attachment is spent, not left behind for the next message.
    await vi.waitFor(() => { expect(chip()).toBeNull() })
  })

  it('surfaces a picker error and disarms', async () => {
    await renderConnected()
    await act(async () => { pickButton().click() })

    await act(async () => {
      onPickResult?.({ status: 'error', message: 'The controlled tab closed.' })
    })

    await vi.waitFor(() => {
      expect(document.querySelector('.error')?.textContent ?? '').toContain('closed')
    })
    await vi.waitFor(() => { expect(pickButton().getAttribute('aria-pressed')).toBe('false') })
  })

  it('cancels an armed picker on Escape from the panel side', async () => {
    await renderConnected()
    await act(async () => { pickButton().click() })
    await vi.waitFor(() => { expect(pickButton().getAttribute('aria-pressed')).toBe('true') })

    // Pressing the button put focus in the side panel, so the page's own Escape
    // listener never sees this key. Without a panel-side handler the overlay
    // would stay armed until something unrelated ended the session.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    await vi.waitFor(() => { expect(cancelPicker).toHaveBeenCalledTimes(1) })
    await vi.waitFor(() => { expect(pickButton().getAttribute('aria-pressed')).toBe('false') })
  })

  it('leaves Escape alone when no pick is armed', async () => {
    await renderConnected()

    // Escape at rest belongs to whatever else owns it; the picker must not
    // swallow it and must not call into the background.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(cancelPicker).not.toHaveBeenCalled()
  })

  it('clears the armed state when the pick is cancelled in the page', async () => {
    await renderConnected()
    await act(async () => { pickButton().click() })
    await vi.waitFor(() => { expect(pickButton().getAttribute('aria-pressed')).toBe('true') })

    await act(async () => { onPickResult?.({ status: 'cancelled' }) })

    await vi.waitFor(() => { expect(pickButton().getAttribute('aria-pressed')).toBe('false') })
    expect(chip()).toBeNull()
  })
})
