/**
 * Content script entry: listens for DSH_ACTION messages from the background
 * service worker, runs the action against the real page, and answers with a
 * text-only result. Starts the DOM watcher that marks the snapshot dirty, and
 * the panel-gated watcher that reports what the user highlights.
 *
 * The content script is the only part that touches the page; the bridge and
 * the model never see page internals beyond the structured text snapshots.
 *
 * @module
 */

import { DEFAULT_SNAPSHOT_MAX_CHARS } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import { runAction, ActionError } from './actions.ts'
import { ElementIds } from './ids.ts'
import { handleInputSetup } from './input-support.ts'
import { ElementPickerSession } from './picker.ts'
import { SelectionWatcher } from './selection.ts'
import type { InputSetupRequest } from '../shared/input-setup.ts'
import type { SnapshotBudget } from './snapshot.ts'

/** Negotiated snapshot budgets, patched in from the background via message. */
let budget: SnapshotBudget = { maxItems: 60, maxForms: 30, maxChars: DEFAULT_SNAPSHOT_MAX_CHARS }

const ids = new ElementIds()

const selectionWatcher = new SelectionWatcher((selection) => {
  void chrome.runtime.sendMessage({ type: 'DSH_SELECTION', selection }).catch(() => {})
})

/**
 * The picker reports through the same one-shot channel as a selection: the
 * background decides whether this frame is allowed to answer, so the content
 * script never needs to know which tab or frame it is in.
 */
const pickerSession = new ElementPickerSession(
  {
    onPick: (element) => {
      void chrome.runtime.sendMessage({ type: 'DSH_PICKED_ELEMENT', element }).catch(() => {})
    },
    onEnd: (reason) => {
      void chrome.runtime.sendMessage({ type: 'DSH_PICKER_ENDED', reason }).catch(() => {})
    },
  },
  (el) => ids.indexOf(el),
)

const CONTENT_SCRIPT_LISTENER = '__dshBrowserContentScriptListener__'
const CONTENT_SELECTION_WATCHER = '__dshBrowserSelectionWatcher__'
type ContentListener = typeof onMessage

/** A tool-call result for the bridge. */
export interface ToolResult {
  ok: boolean
  result?: { text: string; pageContent?: string; navigationPending?: boolean }
  error?: { code: string; message: string }
}

function onMessage(message: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void): true | undefined {
  if (typeof message !== 'object' || message === null) return
  const msg = message as { type?: string }
  if (msg.type === 'DSH_INPUT_SETUP') {
    // Internal trusted-input plumbing: focus/selection/geometry for the
    // background's debugger-driven pointer and keyboard. Never model-facing.
    const request = (message as { request?: InputSetupRequest }).request
    if (request === undefined) {
      sendResponse({ ok: false, error: { code: 'bad-args', message: 'input setup request is missing.' } })
      return
    }
    try {
      sendResponse({ ok: true, result: handleInputSetup(request, ids) })
    } catch (error: unknown) {
      sendResponse({
        ok: false,
        error: {
          code: error instanceof ActionError ? error.code : 'action-failed',
          message: error instanceof Error ? error.message : String(error),
        },
      })
    }
    return
  }
  if (msg.type === 'DSH_BUDGET') {
    const incoming = (message as { budget?: Partial<SnapshotBudget> }).budget
    if (incoming !== undefined) {
      budget = { ...budget, ...incoming }
      sendResponse({ ok: true, result: { text: `快照预算已更新: ${JSON.stringify(budget)}` } })
    }
    return
  }
  if (msg.type === 'DSH_SELECTION_WATCH') {
    const command = message as { enabled?: unknown; epoch?: unknown; revision?: unknown }
    const epoch = typeof command.epoch === 'string' ? command.epoch : undefined
    const revision = typeof command.revision === 'number' ? command.revision : undefined
    selectionWatcher.setEnabled(command.enabled === true, revision, epoch)
    sendResponse({ ok: true })
    return
  }
  if (msg.type === 'DSH_SELECTION_RESET') {
    // The panel dropped this frame's quote; let the same passage be re-reported.
    selectionWatcher.resetDedupe()
    sendResponse({ ok: true })
    return
  }
  if (msg.type === 'DSH_PICKER') {
    // Arm/disarm, with the same epoch+revision ordering as the selection
    // watcher: the background arms every frame and a late arm must not undo a
    // newer cancel.
    const command = message as {
      enabled?: unknown
      epoch?: unknown
      sessionId?: unknown
    }
    const epoch = typeof command.epoch === 'string' ? command.epoch : 'legacy'
    const revision = typeof command.sessionId === 'number' ? command.sessionId : 0
    pickerSession.setEnabled(command.enabled === true, revision, epoch)
    sendResponse({ ok: true, result: { active: pickerSession.active } })
    return
  }
  if (msg.type !== 'DSH_ACTION') return
  const actionMsg = message as {
    action?: string
    args?: Record<string, unknown>
    budget?: Partial<SnapshotBudget>
    includePageDelta?: boolean
  }
  const action = actionMsg.action ?? ''
  const args = actionMsg.args ?? {}
  const actionBudget = actionMsg.budget === undefined ? budget : { ...budget, ...actionMsg.budget }
  void runAction(action, args, {
    ids,
    budget: actionBudget,
    includePageDelta: actionMsg.includePageDelta === true,
  }).then(
    (result) => { sendResponse({ ok: true, result }) },
    (error: unknown) => {
      const code = error instanceof ActionError ? error.code : 'action-failed'
      const messageText = error instanceof Error ? error.message : String(error)
      sendResponse({ ok: false, error: { code, message: messageText } })
    },
  )
  return true // async response
}

// executeScript is used to recover tabs opened before extension install/reload.
// Replace any stale listener left in the isolated world so a reload always
// installs a listener belonging to the current extension context.
const contentGlobal = globalThis as typeof globalThis & {
  [CONTENT_SCRIPT_LISTENER]?: ContentListener
  [CONTENT_SELECTION_WATCHER]?: { dispose: () => void }
  '__dshBrowserPickerSession__'?: { cancel: () => void }
}
const previousListener = contentGlobal[CONTENT_SCRIPT_LISTENER]
if (previousListener !== undefined) {
  try { chrome.runtime.onMessage.removeListener(previousListener) } catch { /* stale extension context */ }
}
// A replaced content script keeps its page listeners until this instance
// releases them: `selectionchange` is a document listener, not an extension one.
contentGlobal[CONTENT_SELECTION_WATCHER]?.dispose()
// A picker overlay outlives a script reload just as badly: it would sit on the
// page intercepting clicks with no listener left to receive the pick.
contentGlobal['__dshBrowserPickerSession__']?.cancel()
contentGlobal[CONTENT_SCRIPT_LISTENER] = onMessage
contentGlobal[CONTENT_SELECTION_WATCHER] = selectionWatcher
contentGlobal['__dshBrowserPickerSession__'] = pickerSession
chrome.runtime.onMessage.addListener(onMessage)

// A navigation action answers before unloading. The replacement content
// script announces when the new document can accept its automatic snapshot,
// and learns from the reply whether a side panel wants selection reports.
void chrome.runtime.sendMessage({ type: 'DSH_CONTENT_READY' }).then((response: unknown) => {
  if (typeof response !== 'object' || response === null) return
  const ready = response as {
    selectionWatch?: unknown
    selectionWatchEpoch?: unknown
    selectionWatchRevision?: unknown
  }
  const epoch = typeof ready.selectionWatchEpoch === 'string' ? ready.selectionWatchEpoch : undefined
  const revision = typeof ready.selectionWatchRevision === 'number' ? ready.selectionWatchRevision : undefined
  selectionWatcher.setEnabled(ready.selectionWatch === true, revision, epoch)
}).catch(() => {})
