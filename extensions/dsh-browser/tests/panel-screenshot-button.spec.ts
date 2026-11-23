// @vitest-environment jsdom

/**
 * The composer's camera button: the person presses it, the background captures
 * the controlled tab, and the pixels land in the draft as an attachment.
 *
 * Two things are worth pinning here beyond "it works":
 * - The capture is offered, never sent on its own. The person can look at it
 *   first, exactly like a picked file.
 * - A refusal from the background surfaces as an error and leaves the draft
 *   untouched, so a failed capture cannot silently attach nothing.
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

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

describe('capturing the controlled page into the composer', () => {
  let root: Root
  let onStatus: ((state: 'connected', caps: null) => void) | undefined
  let onResumeHint: ((sessionId: string | null) => void) | undefined
  let rpc: Mock<(method: string, payload?: unknown) => Promise<unknown>>
  let capture: Mock<PanelApi['captureScreenshot']>

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

    capture = vi.fn(async () => ({
      data: PNG_BASE64,
      mediaType: 'image/png',
      width: 1280,
      height: 720,
      bytes: 70,
    }))

    rpc = vi.fn(async (method: string) => {
      if (method === 'session.create') return { sessionId: 'session-current' }
      if (method === 'session.history') {
        // The composer's image controls stay disabled without a host-declared
        // image capability, so the fixture must advertise one.
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
      captureScreenshot: capture,
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

  function camera(): HTMLButtonElement {
    return document.querySelector<HTMLButtonElement>('.composer-actions button.screenshot-button')!
  }

  function draftImages(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>('.draft-image')]
  }

  it('attaches the capture to the draft instead of sending it', async () => {
    await renderConnected()
    expect(draftImages()).toHaveLength(0)

    await act(async () => { camera().click() })

    await vi.waitFor(() => { expect(draftImages()).toHaveLength(1) })
    expect(capture).toHaveBeenCalledTimes(1)
    // Offered, not sent: no prompt may leave on a bare capture.
    expect(rpc.mock.calls.some(([method]) => method === 'session.prompt')).toBe(false)
    // And the pixels really reached the thumbnail.
    expect(draftImages()[0]?.querySelector('img')?.getAttribute('src')).toContain('data:image/png;base64,')
  })

  it('surfaces a refusal and leaves the draft empty', async () => {
    await renderConnected()
    capture.mockRejectedValueOnce(new Error('The controlled tab is not the active tab of its window.'))

    await act(async () => { camera().click() })

    await vi.waitFor(() => {
      expect(document.querySelector('.error')?.textContent ?? '').toContain('not the active tab')
    })
    expect(draftImages()).toHaveLength(0)
  })

  it('ignores a second press while the first capture is in flight', async () => {
    await renderConnected()
    let release: ((value: { data: string; mediaType: string; width: number; height: number }) => void) | undefined
    capture.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))

    await act(async () => { camera().click() })
    await act(async () => { camera().click() })

    // The in-flight press must not start a second capture.
    expect(capture).toHaveBeenCalledTimes(1)

    await act(async () => {
      release?.({ data: PNG_BASE64, mediaType: 'image/png', width: 800, height: 600 })
    })
    await vi.waitFor(() => { expect(draftImages()).toHaveLength(1) })
  })
})
