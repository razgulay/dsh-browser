// @vitest-environment jsdom

/**
 * The composer's camera button, background side.
 *
 * The regression this file exists for: the handler first read the affinity
 * controller directly, so a panel that had not bound a tab yet was told "no page
 * is being controlled" even though a page was plainly on screen. Capture must
 * resolve the target the same way a tool call does — binding the active tab on
 * first use — and it must never raise an approval prompt, because the press is
 * the consent.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

function chromeEvent<T extends unknown[]>() {
  const listeners = new Set<(...args: T) => void>()
  return {
    addListener: vi.fn((listener: (...args: T) => void) => { listeners.add(listener) }),
    emit: (...args: T) => { for (const listener of listeners) listener(...args) },
  }
}

function panelPort() {
  const onMessage = chromeEvent<[unknown]>()
  const onDisconnect = chromeEvent<[]>()
  const postMessage = vi.fn()
  const port = { name: 'dsh-panel', postMessage, onMessage, onDisconnect } as unknown as chrome.runtime.Port
  return { onDisconnect, onMessage, port, postMessage }
}

/** 1x1 transparent PNG. */
const PNG_PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

function tab(tabId: number, active = true): chrome.tabs.Tab {
  return {
    id: tabId,
    index: 0,
    pinned: false,
    highlighted: active,
    active,
    incognito: false,
    selected: active,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
    windowId: 1,
    title: `Tab ${tabId}`,
    url: `https://example.com/${tabId}`,
  }
}

function mockChrome() {
  const onConnect = chromeEvent<[chrome.runtime.Port]>()
  const query = vi.fn(async () => [tab(1)])
  const captureVisibleTab = vi.fn(async () => `data:image/png;base64,${PNG_PIXEL}`)
  vi.stubGlobal('chrome', {
    alarms: { create: vi.fn(), clear: vi.fn(async () => true), onAlarm: chromeEvent<[chrome.alarms.Alarm]>() },
    notifications: { create: vi.fn(async () => ''), clear: vi.fn(async () => true), onClicked: chromeEvent<[string]>() },
    runtime: {
      id: 'test-extension',
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onConnect,
      onMessage: chromeEvent<[unknown, chrome.runtime.MessageSender, (response: unknown) => void]>(),
    },
    sidePanel: { open: vi.fn(async () => {}), setPanelBehavior: vi.fn(async () => {}) },
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
    },
    tabs: {
      get: vi.fn(async (tabId: number) => tab(tabId)),
      query,
      captureVisibleTab,
      sendMessage: vi.fn(async () => {}),
      onActivated: chromeEvent<[{ tabId: number; windowId: number }]>(),
      onUpdated: chromeEvent<[number, chrome.tabs.TabChangeInfo, chrome.tabs.Tab]>(),
      onReplaced: chromeEvent<[number, number]>(),
      onRemoved: chromeEvent<[number]>(),
    },
    webNavigation: { onCommitted: chromeEvent<[{ tabId: number; frameId: number }]>() },
    windows: {
      WINDOW_ID_NONE: -1,
      get: vi.fn(async () => ({ id: 1, focused: true })),
      onFocusChanged: chromeEvent<[number]>(),
      onRemoved: chromeEvent<[number]>(),
    },
  } as unknown as typeof chrome)
  return { captureVisibleTab, onConnect, query }
}

async function connectPanelForTest() {
  const chromeMock = mockChrome()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
  await import('../src/background/index.ts')
  await vi.waitFor(() => { expect(chromeMock.query).toHaveBeenCalled() })

  const panel = panelPort()
  chromeMock.onConnect.emit(panel.port)
  await vi.waitFor(() => {
    expect(panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'tab-affinity' }))
  })
  panel.postMessage.mockClear()
  return { ...chromeMock, ...panel }
}

afterEach(() => {
  vi.useRealTimers()
  vi.resetModules()
  vi.unstubAllGlobals()
})

describe('panel camera capture', () => {
  it('binds the active tab on first use instead of refusing', async () => {
    const { onMessage, postMessage, captureVisibleTab } = await connectPanelForTest()

    // No prompt and no rebind yet: the panel is connected but unbound.
    onMessage.emit({ type: 'screenshot.capture', id: 'shot-1' })

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
        type: 'screenshot.result',
        id: 'shot-1',
        ok: true,
      }))
    })
    // The capture really happened against the freshly bound page.
    expect(captureVisibleTab).toHaveBeenCalled()
    const result = postMessage.mock.calls
      .map(([message]) => message as { type?: string; result?: { image?: { data?: string } } })
      .find((message) => message.type === 'screenshot.result')
    expect(result?.result?.image?.data).toBe(PNG_PIXEL)
  })

  it('refuses, with a message, when the active tab cannot be bound at all', async () => {
    const { onMessage, postMessage, query } = await connectPanelForTest()
    query.mockResolvedValue([])

    onMessage.emit({ type: 'screenshot.capture', id: 'shot-2' })

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
        type: 'screenshot.result',
        id: 'shot-2',
        ok: false,
      }))
    })
    const result = postMessage.mock.calls
      .map(([message]) => message as { type?: string; error?: { message?: string } })
      .find((message) => message.type === 'screenshot.result')
    expect(result?.error?.message).toBeTruthy()
    // A refusal must say which condition failed, not leak an empty object.
    expect(result?.error?.message).not.toContain('undefined')
  })

  it('never asks for approval before capturing', async () => {
    const { onMessage, postMessage } = await connectPanelForTest()

    onMessage.emit({ type: 'screenshot.capture', id: 'shot-3' })

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'screenshot.result', id: 'shot-3' }))
    })
    // The press is the consent: no approval frame may be emitted for it.
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'approval.request' }))
  })
})
