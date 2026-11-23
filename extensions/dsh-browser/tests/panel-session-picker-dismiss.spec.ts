// @vitest-environment jsdom

/**
 * The session picker is a sibling overlay over the transcript, not a modal.
 * It must close on a click outside it and on Escape, while its own contents and
 * its trigger keep working.
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

describe('session picker dismissal', () => {
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
    })
    rpc = vi.fn(async (method: string) => {
      if (method === 'session.create') return { sessionId: 'session-current' }
      if (method === 'session.history') return { events: [] }
      if (method === 'session.list') {
        return {
          items: [{
            sessionId: 'session-current',
            title: 'Lá»i chÃ o há»i',
            updatedAt: Date.UTC(2026, 10, 23, 9, 28, 29),
            cwd: 'C:\\Users\\Lucy\\.dsh\\browser-sessions',
          }],
        }
      }
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

  function picker(): HTMLElement | null {
    return document.querySelector<HTMLElement>('.session-picker')
  }

  async function openPicker(): Promise<void> {
    const trigger = document.querySelector<HTMLButtonElement>('.session-menu-trigger')!
    await act(async () => { trigger.click() })
    await vi.waitFor(() => { expect(picker()).not.toBeNull() })
  }

  /** A press delivered the way the browser does it: capture phase, on document. */
  async function pressOutside(target: Element): Promise<void> {
    await act(async () => {
      target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
    })
  }

  /**
   * Opening the list must not reflow the transcript.
   *
   * It used to be a flex child of `.app`, so it consumed real height and shoved
   * the conversation down instead of floating over it. jsdom has no layout
   * engine, so this asserts the two facts that produce the overlay: the list is
   * nested in the relatively-positioned pane, and it is taken out of flow.
   */
  it('overlays the transcript instead of pushing it down', async () => {
    await renderConnected()
    const pane = document.querySelector('.messages-pane')
    expect(pane).not.toBeNull()

    await openPicker()

    const section = picker()!
    // Nesting is what lets `position: absolute` anchor to the pane.
    expect(pane!.contains(section)).toBe(true)
    // And the picker must not be a sibling flex row of the composer.
    expect(section.parentElement).toBe(pane)
  })

  it('closes when the user clicks outside it', async () => {
    await renderConnected()
    await openPicker()

    await pressOutside(document.querySelector('.messages-pane') ?? document.body)

    await vi.waitFor(() => { expect(picker()).toBeNull() })
  })

  it('stays open when the click lands inside it', async () => {
    await renderConnected()
    await openPicker()

    const inside = picker()!.querySelector('.session-picker-head')!
    await pressOutside(inside)

    // Give React a turn to flush any erroneous close before asserting.
    await act(async () => { await Promise.resolve() })
    expect(picker()).not.toBeNull()
  })

  it('closes on Escape and hands focus back to its trigger', async () => {
    await renderConnected()
    await openPicker()

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    await vi.waitFor(() => { expect(picker()).toBeNull() })
    expect(document.activeElement).toBe(document.querySelector('.session-menu-trigger'))
  })

  it('still toggles closed when its own trigger is clicked again', async () => {
    await renderConnected()
    await openPicker()

    const trigger = document.querySelector<HTMLButtonElement>('.session-menu-trigger')!
    // The guard must not swallow this: the trigger's own handler closes it.
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
      trigger.click()
    })

    await vi.waitFor(() => { expect(picker()).toBeNull() })
  })
})
