// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { PanelApi } from '../src/panel/api.ts'
import type { TabAffinityState } from '../src/background/tab-affinity.ts'

let panelApi: PanelApi

vi.mock('../src/panel/api.ts', () => ({
  connectPanel: (): PanelApi => panelApi,
}))

import { App } from '../src/panel/App.tsx'

const controlled = { tabId: 1, windowId: 1, title: 'Pull request #3', url: 'https://example.com/pr' }
const active = { tabId: 2, windowId: 1, title: 'README', url: 'https://example.com/readme' }

describe('tab handoff banner', () => {
  let root: Root
  let onStatus: ((state: 'connected', caps: null) => void) | undefined
  let onResumeHint: ((sessionId: string | null) => void) | undefined
  let onTabAffinity: ((state: TabAffinityState) => void) | undefined
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
      onTabAffinity: vi.fn((callback) => { onTabAffinity = callback; return unsubscribe }),
      onSelection: vi.fn(() => unsubscribe),
      onSessionResumeHint: vi.fn((callback) => { onResumeHint = callback; return unsubscribe }),
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
    })
  }

  async function pushAffinity(state: TabAffinityState): Promise<void> {
    await act(async () => { onTabAffinity?.(state) })
  }

  function actionLabels(): string[] {
    return [...document.querySelectorAll<HTMLButtonElement>('.tab-affinity-actions button')]
      .map((button) => button.textContent ?? '')
  }

  it('offers only the two binding answers', async () => {
    await renderConnected()

    await pushAffinity({
      revision: 3,
      status: 'handoff',
      controlled,
      active,
      pinned: false,
    })

    expect(actionLabels()).toEqual(['Stay', 'Follow'])
  })

  it('sends the choice against the revision it was shown for', async () => {
    await renderConnected()
    await pushAffinity({
      revision: 3,
      status: 'handoff',
      controlled,
      active,
      pinned: false,
    })

    const stay = document.querySelector<HTMLButtonElement>('.tab-affinity-actions .keep')!
    await act(async () => { stay.click() })

    await vi.waitFor(() => { expect(panelApi.resolveTabAffinity).toHaveBeenCalledTimes(1) })
    expect(vi.mocked(panelApi.resolveTabAffinity).mock.calls[0]?.slice(0, 2)).toEqual([3, 'keep'])
  })

  it('offers only to follow once the user has already chosen', async () => {
    await renderConnected()

    await pushAffinity({
      revision: 4,
      status: 'background',
      controlled,
      active,
      pinned: false,
    })

    // The background banner keeps its own wording: it offers to follow, not to answer.
    expect(actionLabels()).toEqual(['Follow'])
  })

  it('renders each page as its favicon chip, with the full title in the tooltip', async () => {
    await renderConnected()
    await pushAffinity({
      revision: 5,
      status: 'handoff',
      controlled: { ...controlled, favIconUrl: 'https://example.com/favicon.ico' },
      active: { ...active, favIconUrl: 'data:image/png;base64,iVBORw0KGgo=' },
      pinned: false,
    })

    const chips = [...document.querySelectorAll<HTMLElement>('.tab-affinity-chip')]
    expect(chips).toHaveLength(2)
    expect(chips[0]?.querySelector('img')?.getAttribute('src')).toBe('https://example.com/favicon.ico')
    expect(chips[1]?.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=')
    expect(chips[0]?.dataset.tip).toContain('Pull request #3')
    expect(chips[1]?.dataset.tip).toContain('README')
  })

  it('refuses an unsafe favicon and falls back to a letter tile', async () => {
    await renderConnected()
    await pushAffinity({
      revision: 6,
      status: 'handoff',
      // A hostile page can put anything in favIconUrl; the panel must not render it.
      controlled: { ...controlled, favIconUrl: 'javascript:alert(1)' },
      active: { ...active, favIconUrl: 'data:text/html,<script>alert(1)</script>' },
      pinned: false,
    })

    const chips = [...document.querySelectorAll<HTMLElement>('.tab-affinity-chip')]
    expect(chips).toHaveLength(2)
    for (const chip of chips) {
      expect(chip.querySelector('img')).toBeNull()
      // The row must not lose its geometry when the icon is unusable.
      expect(chip.querySelector('.tab-affinity-letter')?.textContent).toMatch(/^[A-Z#]$/)
    }
  })

  it('never renders a digit as the fallback initial', async () => {
    await renderConnected()
    await pushAffinity({
      revision: 7,
      status: 'handoff',
      // An IP host has no leading letter; a digit would read as a badge count.
      controlled: { tabId: 1, windowId: 1, title: 'Gateway', url: 'http://127.0.0.1:3080/' },
      active,
      pinned: false,
    })

    const chips = [...document.querySelectorAll<HTMLElement>('.tab-affinity-chip')]
    expect(chips[0]?.querySelector('.tab-affinity-letter')?.textContent).not.toMatch(/^\d$/)
  })

  it('greys and strikes the assistant chip when the controlled tab is gone', async () => {
    await renderConnected()
    await pushAffinity({
      revision: 8,
      status: 'lost',
      controlled: null,
      active,
      pinned: false,
    })

    const assistant = document.querySelector<HTMLElement>('.tab-affinity-chip[data-role="assistant"]')
    expect(assistant?.dataset.tone).toBe('closed')
    expect(document.querySelector('.tab-affinity-link')?.classList.contains('severed')).toBe(true)
    const name = document.querySelector('.tab-affinity-node:first-child .tab-affinity-name')
    expect(name?.textContent).toBe('Closed tab')
  })
})
