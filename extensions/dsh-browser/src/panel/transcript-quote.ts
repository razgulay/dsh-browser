/**
 * Quoting part of the conversation transcript, the way the chat clients do:
 * highlight a passage, and it becomes an attachment on the next message.
 *
 * Two things make this different from quoting a page (see `selection.ts`):
 *
 * - The text is not page-authored, it is transcript-authored. It is still
 *   *someone else's* words from the model's point of view, so it ships with an
 *   explicit attribution header and inside a fenced block rather than being
 *   pasted in as if the user had typed it. A reader of the prompt can then tell
 *   "the user is pointing at this" from "the user is saying this".
 * - The selection can span several rendered rows, each with its own markdown,
 *   so it arrives as DOM text with layout-induced line breaks and indentation.
 *   Normalizing that is the whole job of `normalizeTranscriptQuote`: without it
 *   a three-line quote turns into thirty blank-line-separated fragments.
 *
 * @module
 */

/** A highlight longer than this is cut; the note says so. */
export const MAX_TRANSCRIPT_QUOTE_CHARS = 4_000

const QUOTE_HEADER = '[quoted transcript] The user selected text in this conversation and quoted it below.'

/** One recovered quote, ready to render as a composer chip. */
export interface TranscriptQuote {
  text: string
  truncated: boolean
}

/**
 * Clean a raw DOM selection into quotable text.
 *
 * Collapses runs of whitespace and blank lines, trims the edges, and caps the
 * length. Returns undefined for a selection that is empty after cleaning, so
 * callers can treat "nothing usable" and "no selection" the same way.
 *
 * @param raw - `Selection.toString()`, or anything else.
 * @returns the cleaned quote, or undefined when there is nothing to quote.
 */
export function normalizeTranscriptQuote(raw: unknown): TranscriptQuote | undefined {
  if (typeof raw !== 'string') return undefined
  const collapsed = raw
    // Rendered rows are separate block elements; the selection joins them with
    // newlines plus the indentation of the next element.
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\u00A0]+/g, ' ').trim())
    // Blank lines in a rendered transcript are block spacing, not the author's
    // paragraphing, so they are dropped rather than collapsed to one: keeping
    // them would add empty rows to every quote that spans two messages.
    .filter((line) => line !== '')
    .join('\n')
    .trim()
  if (collapsed === '') return undefined
  const truncated = collapsed.length > MAX_TRANSCRIPT_QUOTE_CHARS
  return {
    text: truncated ? collapsed.slice(0, MAX_TRANSCRIPT_QUOTE_CHARS) : collapsed,
    truncated,
  }
}

/**
 * Compose the prompt body for a message that quotes the transcript.
 *
 * The quote is fenced and attributed; the user's own words follow it outside
 * the fence, so the boundary between "what was quoted" and "what was asked"
 * survives a multi-paragraph quote.
 *
 * @param quote - the cleaned quote.
 * @param message - what the user typed; may be empty.
 * @returns the attributed quote block, followed by the user's own words.
 */
export function transcriptQuotePromptText(quote: TranscriptQuote, message: string): string {
  const body = [
    QUOTE_HEADER,
    '<QUOTED_TRANSCRIPT>',
    quote.text,
    quote.truncated ? '…(quote truncated at the length limit)' : '',
    '</QUOTED_TRANSCRIPT>',
  ].filter((line) => line !== '')
    .join('\n')
  const text = message.trim()
  return text === '' ? body : `${body}\n\n${text}`
}

/**
 * Recover the quote from a stored message, for the history card.
 *
 * Kept next to the composer so the two formats cannot drift: a session resume
 * has only the message itself to rebuild the quote card from.
 *
 * @param text - a stored user message.
 * @returns the quote, or null when the message carries none.
 */
export function splitTranscriptQuoteMessage(text: string): { quote: TranscriptQuote; message: string } | null {
  const open = '<QUOTED_TRANSCRIPT>\n'
  const close = '\n</QUOTED_TRANSCRIPT>'
  if (!text.startsWith(`${QUOTE_HEADER}\n${open}`)) return null
  const bodyStart = QUOTE_HEADER.length + 1 + open.length
  const bodyEnd = text.indexOf(close, bodyStart)
  if (bodyEnd === -1) return null
  const raw = text.slice(bodyStart, bodyEnd)
  const truncated = raw.endsWith('\n…(quote truncated at the length limit)')
  const quote: TranscriptQuote = {
    text: truncated ? raw.slice(0, raw.length - '\n…(quote truncated at the length limit)'.length) : raw,
    truncated,
  }
  const after = text.indexOf('\n\n', bodyEnd + close.length)
  return { quote, message: after === -1 ? '' : text.slice(after + 2) }
}
