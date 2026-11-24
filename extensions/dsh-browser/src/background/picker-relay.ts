/**
 * Element picker relay, background side.
 *
 * The panel asks for a pick; this module arms every frame of the controlled
 * tab, waits for the first frame to report an element, then disarms the rest.
 * Living outside `index.ts` keeps the tab-resolution and frame plumbing testable
 * without a full service-worker harness.
 *
 * Frame handling is where this differs from a page-only inspector. Frame ids
 * survive navigation and element ids do not: an inventory number is only
 * meaningful inside the frame that issued it, so every result carries its
 * `frameId` and the frame's URL. Dropping that would let a pick in an iframe
 * resolve to a same-numbered element in the parent — a silent wrong click.
 *
 * @module
 */

/** A pick as reported by one frame, before the panel attaches it. */
export interface PickedElementPayload {
  index?: number
  selector?: string
  tag?: string
  role?: string
  name?: string
  attributes?: Record<string, string>
  text?: string
  rect?: { x: number; y: number; width: number; height: number }
  masked?: boolean
}

/** Result of one picker session. */
export type PickerOutcome =
  | { status: 'picked'; frameId: number; frameUrl: string; element: PickedElementPayload }
  | { status: 'cancelled' }
  | { status: 'error'; message: string }

/** What the relay needs from the environment, injected so tests stay honest. */
export interface PickerRelayPorts {
  /** Send one message to one frame; rejects when the frame has no listener. */
  sendToFrame(tabId: number, frameId: number, message: unknown): Promise<unknown>
  /** Every live frame of the tab, main frame first. */
  listFrames(tabId: number): Promise<Array<{ frameId: number; url: string }>>
  /** Deliver the end of a session to the panel exactly once. */
  report(outcome: PickerOutcome): void
  /**
   * Make the tab scriptable before arming it.
   *
   * Manifest content scripts do not run in tabs that were already open when the
   * extension was installed or reloaded, and a freshly opened tab has no
   * receiver until something injects one. Without this the picker works only on
   * tabs a tool already visited — which looks like "it only works on the tab I
   * followed".
   */
  prepare?(tabId: number): Promise<void>
}

/** One in-flight picker session. */
interface ActiveSession {
  tabId: number
  /** Monotonic id so a late frame reply from an old session is ignored. */
  sessionId: number
  epoch: string
  finished: boolean
  ports: PickerRelayPorts
  /** Frames that acknowledged the arm; zero means the session can never end. */
  armedFrames: number
}

let sessionCounter = 0
let active: ActiveSession | null = null
/** Worker lifetime; a restart makes every in-flight session reply stale. */
let currentEpoch = crypto.randomUUID()

/**
 * Begin a picker session across every frame of one tab.
 *
 * @param tabId - the tab whose frames are armed.
 * @param ports - frame messaging and the panel report channel.
 * @returns the session id, or undefined when the tab has nothing to arm.
 */
export async function startPicker(tabId: number, ports: PickerRelayPorts): Promise<number | undefined> {
  if (active !== null) return undefined
  sessionCounter += 1
  const session: ActiveSession = {
    tabId,
    sessionId: sessionCounter,
    epoch: currentEpoch,
    finished: false,
    ports,
    armedFrames: 0,
  }
  active = session

  let frames: Array<{ frameId: number; url: string }>
  try {
    frames = await ports.listFrames(tabId)
  } catch (error: unknown) {
    endSession(session, {
      status: 'error',
      message: error instanceof Error ? error.message : 'The page frames could not be listed.',
    })
    return undefined
  }
  // A page can legitimately report no frames between navigations; arming
  // nothing would leave the user with a button that does nothing.
  if (frames.length === 0) {
    endSession(session, { status: 'error', message: 'The page has no reachable frame to pick from.' })
    return undefined
  }

  // Arm every frame. A frame with no content script (protected, or freshly
  // navigated) rejects; that is expected and not fatal, because the others still
  // make the session usable. `prepare` narrows that window by installing the
  // script first.
  if (ports.prepare !== undefined) {
    try { await ports.prepare(tabId) } catch { /* a protected page stays unarmed */ }
  }
  await Promise.all(frames.map((frame) =>
    ports.sendToFrame(tabId, frame.frameId, {
      type: 'DSH_PICKER',
      enabled: true,
      epoch: session.epoch,
      sessionId: session.sessionId,
    }).then(() => { session.armedFrames += 1 }, () => undefined)))

  // If not one frame accepted the arm, the session is a no-op that would leave
  // the button lit over a page that will never answer. Fail loudly instead.
  if (session.armedFrames === 0) {
    endSession(session, {
      status: 'error',
      message: 'The picker could not be loaded on this page. It may be a protected page or one that blocks extension scripts.',
    })
    return undefined
  }

  return session.sessionId
}

/**
 * Abandon the live session and disarm every frame.
 *
 * Called when the user cancels, when the panel closes, and when the panel asked
 * for a new pick. The content script's revision ordering makes a late arm lose
 * to this disarm rather than resurrecting a dismissed overlay.
 */
export async function stopPicker(): Promise<void> {
  if (active === null) return
  endSession(active, { status: 'cancelled' })
}

/**
 * Record a pick reported by one frame and end the session.
 *
 * @param tabId - the tab the message came from.
 * @param frameId - the frame that reported it.
 * @param frameUrl - that frame's URL, for the attachment header.
 * @param value - the raw element payload; validated here, not trusted.
 * @returns true when the pick belonged to the live session.
 */
export async function acceptPick(
  tabId: number,
  frameId: number,
  frameUrl: string,
  value: unknown,
): Promise<boolean> {
  const session = active
  if (session === null || session.finished || session.tabId !== tabId) return false
  const element = parsePickedElement(value)
  if (element === null) {
    endSession(session, { status: 'error', message: 'The page reported an element that could not be used.' })
    return true
  }
  endSession(session, { status: 'picked', frameId, frameUrl, element })
  return true
}

/** End a session: mark it done, disarm, then report once. */
function endSession(session: ActiveSession, outcome: PickerOutcome): void {
  if (session.finished) return
  session.finished = true
  if (active === session) active = null
  void (async () => {
    const { ports, tabId } = session
    try {
      const frames = await ports.listFrames(tabId)
      await Promise.all(frames.map((frame) =>
        ports.sendToFrame(tabId, frame.frameId, {
          type: 'DSH_PICKER',
          enabled: false,
          epoch: session.epoch,
          sessionId: session.sessionId,
        }).catch(() => undefined)))
    } catch {
      // Frames that vanished need no disarm.
    }
    ports.report(outcome)
  })()
}

/** Whether a picker session is live for one tab. */
export function pickerActiveFor(tabId: number): boolean {
  return active !== null && active.tabId === tabId
}

/** Invalidate every session, as a worker restart must. */
export function resetPickerForNewEpoch(): void {
  currentEpoch = crypto.randomUUID()
  const session = active
  if (session === null) return
  session.finished = true
  active = null
}

/** Narrow one frame's reported element. Page-authored, so nothing is assumed. */
export function parsePickedElement(value: unknown): PickedElementPayload | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const text = (input: unknown, max: number): string | undefined =>
    typeof input === 'string' && input.trim() !== '' ? input.slice(0, max) : undefined

  const selector = text(record.selector, 500)
  const tag = text(record.tag, 40)
  const index = typeof record.index === 'number' && Number.isSafeInteger(record.index) && record.index >= 0
    ? record.index
    : undefined
  // A pick with neither an inventory number nor a selector cannot be acted on.
  if (index === undefined && (selector === undefined || tag === undefined)) return null

  const attributes: Record<string, string> = {}
  if (typeof record.attributes === 'object' && record.attributes !== null && !Array.isArray(record.attributes)) {
    let count = 0
    for (const [key, raw] of Object.entries(record.attributes as Record<string, unknown>)) {
      if (count >= 16) break
      if (typeof raw !== 'string') continue
      // Handlers must never survive the hop, whatever the content script sent.
      if (/^on/i.test(key)) continue
      attributes[key.slice(0, 64)] = raw.slice(0, 200)
      count += 1
    }
  }

  const rectSource = typeof record.rect === 'object' && record.rect !== null
    ? record.rect as Record<string, unknown>
    : undefined
  const rectNumber = (input: unknown): number | undefined =>
    typeof input === 'number' && Number.isFinite(input) ? Math.round(input) : undefined
  let rect: PickedElementPayload['rect']
  if (rectSource !== undefined) {
    const x = rectNumber(rectSource.x)
    const y = rectNumber(rectSource.y)
    const width = rectNumber(rectSource.width)
    const height = rectNumber(rectSource.height)
    if (x !== undefined && y !== undefined && width !== undefined && height !== undefined) {
      rect = { x, y, width, height }
    }
  }

  const role = text(record.role, 40)
  const name = text(record.name, 200)
  const body = text(record.text, 400)

  return {
    ...(index === undefined ? {} : { index }),
    ...(selector === undefined ? {} : { selector }),
    ...(tag === undefined ? {} : { tag }),
    ...(role === undefined ? {} : { role }),
    ...(name === undefined ? {} : { name }),
    attributes,
    ...(body === undefined ? {} : { text: body }),
    ...(rect === undefined ? {} : { rect }),
    ...(record.masked === true ? { masked: true } : {}),
  }
}
