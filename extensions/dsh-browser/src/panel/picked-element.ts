/**
 * Formatting a picked element for the model.
 *
 * A picked element is page-authored data: the selector, the attributes, the text
 * all came from the page, and a hostile page controls every one of them. It is
 * therefore fenced the same way a page quote is, with the nonce boundary doing
 * the work — not escaped into the user's own sentence.
 *
 * The one field that is *not* page-authored is the frame identity, which the
 * background derived from `sender`. It still travels inside the fence because it
 * describes the same object.
 *
 * @module
 */

import type { PickedElementResult } from './api.ts'
import { wrapUntrustedContent } from '../security/untrusted.ts'

/** Ceiling for one element block; an element is small, so this is generous. */
const MAX_ELEMENT_BLOCK_CHARS = 4_000

/**
 * Compose the prompt body for a message that carries a picked element.
 *
 * The user's own words stay outside the fence, so a model reading the prompt can
 * tell "this is the element the user pointed at" from "this is what the user is
 * asking about it".
 *
 * @param picked - the pick as the background reported it.
 * @param message - what the user typed; may be empty.
 * @returns the fenced element block, followed by the user's own words.
 */
export function pickedElementPromptText(picked: PickedElementResult, message: string): string {
  const element = picked.element
  if (element === undefined) return message
  const lines: string[] = []
  if (element.index !== undefined) lines.push(`index: ${element.index}`)
  if (element.selector !== undefined) lines.push(`selector: ${element.selector}`)
  if (element.tag !== undefined) lines.push(`tag: ${element.tag}`)
  if (element.role !== undefined) lines.push(`role: ${element.role}`)
  if (element.name !== undefined) lines.push(`name: ${element.name}`)
  const attributes = Object.entries(element.attributes ?? {})
  if (attributes.length > 0) {
    lines.push(`attributes: ${attributes.map(([key, value]) => `${key}="${value}"`).join(' ')}`)
  }
  if (element.text !== undefined) lines.push(`text: ${element.text}`)
  if (element.rect !== undefined) {
    const { x, y, width, height } = element.rect
    lines.push(`rect: ${x},${y} ${width}×${height}`)
  }
  if (element.masked === true) lines.push('masked: true (form field value withheld)')
  // A frame id of 0 is the main document and adds nothing; anything else must be
  // stated, because an inventory number is only meaningful inside its frame.
  if (picked.frameId !== undefined && picked.frameId !== 0) {
    lines.push(`frame-id: ${picked.frameId}`)
    if (picked.frameUrl !== undefined) lines.push(`frame-url: ${picked.frameUrl}`)
  }

  const fenced = wrapUntrustedContent(
    `<selected-element>\n${lines.join('\n')}\n</selected-element>`,
    MAX_ELEMENT_BLOCK_CHARS,
  )
  const text = message.trim()
  return text === '' ? fenced : `${fenced}\n\n${text}`
}
