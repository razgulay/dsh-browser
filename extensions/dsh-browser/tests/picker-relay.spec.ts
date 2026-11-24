// @vitest-environment jsdom

/**
 * Element picker relay, background side.
 *
 * The properties worth pinning are the multi-frame ones: every frame is armed,
 * the first reply ends the session, every frame is then disarmed, and the frame
 * that reported is carried through so a pick inside an iframe cannot be
 * mistaken for a same-numbered element in the parent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acceptPick,
  parsePickedElement,
  pickerActiveFor,
  resetPickerForNewEpoch,
  startPicker,
  stopPicker,
  type PickerOutcome,
  type PickerRelayPorts,
} from '../src/background/picker-relay.ts'

const FRAMES = [
  { frameId: 0, url: 'https://example.com/' },
  { frameId: 3, url: 'https://widget.example.org/embed' },
]

function makePorts(overrides: Partial<PickerRelayPorts> = {}) {
  const sent: Array<{ tabId: number; frameId: number; message: Record<string, unknown> }> = []
  const reported: PickerOutcome[] = []
  const ports: PickerRelayPorts = {
    sendToFrame: vi.fn(async (tabId: number, frameId: number, message: unknown) => {
      sent.push({ tabId, frameId, message: message as Record<string, unknown> })
      return undefined
    }),
    listFrames: vi.fn(async () => FRAMES),
    report: (outcome) => { reported.push(outcome) },
    ...overrides,
  }
  return { ports, sent, reported }
}

/** Let the session's background disarm microtasks run. */
async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve()
}

beforeEach(() => {
  resetPickerForNewEpoch()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('starting a session', () => {
  it('arms every frame including child frames', async () => {
    const { ports, sent } = makePorts()
    const sessionId = await startPicker(7, ports)

    expect(sessionId).toBeTypeOf('number')
    const arms = sent.filter((entry) => entry.message.type === 'DSH_PICKER' && entry.message.enabled === true)
    expect(arms.map((entry) => entry.frameId).sort()).toEqual([0, 3])
    expect(pickerActiveFor(7)).toBe(true)
  })

  it('carries one epoch and session id so stale replies can be rejected', async () => {
    const { ports, sent } = makePorts()
    await startPicker(7, ports)

    const arms = sent.filter((entry) => entry.message.enabled === true)
    const epoch = arms[0]!.message.epoch
    expect(epoch).toBeTypeOf('string')
    for (const arm of arms) {
      expect(arm.message.epoch).toBe(epoch)
      expect(arm.message.sessionId).toBe(arms[0]!.message.sessionId)
    }
  })

  it('refuses a second session while one is live', async () => {
    const { ports } = makePorts()
    await startPicker(7, ports)
    expect(await startPicker(7, ports)).toBeUndefined()
  })

  it('reports an error and arms nothing when there are no frames', async () => {
    const { ports, reported, sent } = makePorts({ listFrames: async () => [] })
    expect(await startPicker(7, ports)).toBeUndefined()
    await settle()

    expect(sent).toHaveLength(0)
    expect(reported[0]).toMatchObject({ status: 'error' })
  })

  it('survives a frame that has no content script', async () => {
    const { ports } = makePorts({
      sendToFrame: vi.fn(async (_tabId: number, frameId: number) => {
        if (frameId === 3) throw new Error('Receiving end does not exist')
        return undefined
      }),
    })
    // The main frame still armed, so the session must stay usable.
    expect(await startPicker(7, ports)).toBeTypeOf('number')
    expect(pickerActiveFor(7)).toBe(true)
  })
})

describe('accepting a pick', () => {
  it('reports the picking frame, its URL, and disarms every frame', async () => {
    const { ports, sent, reported } = makePorts()
    await startPicker(7, ports)
    sent.length = 0

    const accepted = await acceptPick(7, 3, FRAMES[1]!.url, { index: 4, tag: 'a', selector: '#x' })
    expect(accepted).toBe(true)
    await settle()

    expect(reported).toHaveLength(1)
    const outcome = reported[0]!
    expect(outcome.status).toBe('picked')
    if (outcome.status !== 'picked') return
    // The frame identity is what keeps an iframe pick from colliding with a
    // same-numbered element in the parent.
    expect(outcome.frameId).toBe(3)
    expect(outcome.frameUrl).toBe(FRAMES[1]!.url)
    expect(outcome.element.index).toBe(4)

    const disarms = sent.filter((entry) => entry.message.enabled === false)
    expect(disarms.map((entry) => entry.frameId).sort()).toEqual([0, 3])
    expect(pickerActiveFor(7)).toBe(false)
  })

  it('ignores a reply from a tab with no live session', async () => {
    const { reported } = makePorts()
    expect(await acceptPick(99, 0, 'https://other.example/', { tag: 'a', selector: '#a' })).toBe(false)
    await settle()
    expect(reported).toHaveLength(0)
  })

  it('ignores a second reply after the session already ended', async () => {
    const { ports, reported } = makePorts()
    await startPicker(7, ports)

    await acceptPick(7, 0, 'https://example.com/', { tag: 'a', selector: '#first' })
    const second = await acceptPick(7, 3, 'https://widget.example.org/embed', { tag: 'b', selector: '#second' })
    await settle()

    expect(second).toBe(false)
    expect(reported).toHaveLength(1)
  })

  it('reports an error instead of picking an unusable payload', async () => {
    const { ports, reported } = makePorts()
    await startPicker(7, ports)

    // Neither an index nor a selector: nothing the model could act on.
    expect(await acceptPick(7, 0, 'https://example.com/', { tag: 'a' })).toBe(true)
    await settle()
    expect(reported[0]).toMatchObject({ status: 'error' })
  })
})

describe('cancelling', () => {
  it('disarms every frame and reports once', async () => {
    const { ports, sent, reported } = makePorts()
    await startPicker(7, ports)
    sent.length = 0

    await stopPicker()
    await settle()

    expect(reported).toEqual([{ status: 'cancelled' }])
    expect(sent.filter((entry) => entry.message.enabled === false)).toHaveLength(2)
    expect(pickerActiveFor(7)).toBe(false)
  })

  it('does nothing when no session is live', async () => {
    const { sent, reported } = makePorts()
    await stopPicker()
    await settle()
    expect(sent).toHaveLength(0)
    expect(reported).toHaveLength(0)
  })

  it('reports only once even if cancel is called twice', async () => {
    const { ports, reported } = makePorts()
    await startPicker(7, ports)

    await stopPicker()
    await stopPicker()
    await settle()

    expect(reported).toHaveLength(1)
  })

  it('drops an in-flight session on a worker epoch change', async () => {
    const { ports, reported } = makePorts()
    await startPicker(7, ports)

    resetPickerForNewEpoch()
    expect(pickerActiveFor(7)).toBe(false)
    // The old session must not report into a panel that outlived its worker.
    await settle()
    expect(reported).toHaveLength(0)
  })
})

describe('parsePickedElement', () => {
  it('keeps the fields the model can act on', () => {
    const parsed = parsePickedElement({
      index: 12,
      selector: '#go',
      tag: 'button',
      role: 'button',
      name: 'Go',
      attributes: { 'data-role': 'cta' },
      text: 'Go',
      rect: { x: 1.4, y: 2.6, width: 30, height: 40 },
      masked: true,
    })

    expect(parsed).toMatchObject({
      index: 12,
      selector: '#go',
      tag: 'button',
      role: 'button',
      name: 'Go',
      masked: true,
    })
    expect(parsed?.attributes).toEqual({ 'data-role': 'cta' })
    // Rects are rounded for stable rendering.
    expect(parsed?.rect).toEqual({ x: 1, y: 3, width: 30, height: 40 })
  })

  it('strips handlers that survived the content hop', () => {
    const parsed = parsePickedElement({ tag: 'a', selector: '#a', attributes: { onclick: 'steal()', href: '/x' } })
    expect(parsed?.attributes).toEqual({ href: '/x' })
  })

  it('rejects a payload with no usable address', () => {
    expect(parsePickedElement({ tag: 'a' })).toBeNull()
    expect(parsePickedElement({})).toBeNull()
    expect(parsePickedElement(null)).toBeNull()
    expect(parsePickedElement('selector')).toBeNull()
    expect(parsePickedElement([])).toBeNull()
  })

  it('caps oversized values', () => {
    const parsed = parsePickedElement({
      tag: 'a',
      selector: `#${'s'.repeat(900)}`,
      name: 'n'.repeat(900),
      text: 't'.repeat(900),
      attributes: { title: 'v'.repeat(900) },
    })
    expect(parsed!.selector!.length).toBeLessThanOrEqual(500)
    expect(parsed!.name!.length).toBeLessThanOrEqual(200)
    expect(parsed!.text!.length).toBeLessThanOrEqual(400)
    expect(parsed!.attributes!.title!.length).toBeLessThanOrEqual(200)
  })
})
