// @vitest-environment jsdom

/**
 * Quoting the transcript: the text has to survive DOM whitespace, the prompt
 * has to keep the quote distinguishable from the user's own words, and a stored
 * message has to give the card back on session resume.
 */

import { describe, expect, it } from 'vitest'
import {
  MAX_TRANSCRIPT_QUOTE_CHARS,
  normalizeTranscriptQuote,
  splitTranscriptQuoteMessage,
  transcriptQuotePromptText,
} from '../src/panel/transcript-quote.ts'

describe('normalizeTranscriptQuote', () => {
  it('collapses the whitespace a rendered selection drags along', () => {
    // A selection spanning two markdown paragraphs: the DOM hands over the
    // element indentation and blank lines between blocks.
    const raw = '\n   bug tiếp, khi tôi kéo lên trên,   \n\n\n   sau đó gõ và gửi đi,   \n'
    expect(normalizeTranscriptQuote(raw)?.text)
      .toBe('bug tiếp, khi tôi kéo lên trên,\nsau đó gõ và gửi đi,')
  })

  it('keeps intentional single line breaks as one line each', () => {
    expect(normalizeTranscriptQuote('a\nb\nc')?.text).toBe('a\nb\nc')
  })

  it('rejects a selection with nothing but whitespace', () => {
    expect(normalizeTranscriptQuote('   \n\t\n ')).toBeUndefined()
    expect(normalizeTranscriptQuote('')).toBeUndefined()
  })

  it('rejects non-strings', () => {
    expect(normalizeTranscriptQuote(undefined)).toBeUndefined()
    expect(normalizeTranscriptQuote(null)).toBeUndefined()
    expect(normalizeTranscriptQuote(42)).toBeUndefined()
  })

  it('caps a long highlight and flags it', () => {
    const long = 'x'.repeat(MAX_TRANSCRIPT_QUOTE_CHARS + 500)
    const quote = normalizeTranscriptQuote(long)
    expect(quote?.text).toHaveLength(MAX_TRANSCRIPT_QUOTE_CHARS)
    expect(quote?.truncated).toBe(true)
  })

  it('does not flag a quote exactly at the limit', () => {
    const quote = normalizeTranscriptQuote('y'.repeat(MAX_TRANSCRIPT_QUOTE_CHARS))
    expect(quote?.truncated).toBe(false)
  })
})

describe('transcriptQuotePromptText', () => {
  it('fences the quote and keeps the user words outside it', () => {
    const text = transcriptQuotePromptText({ text: 'quoted lines', truncated: false }, 'explain this')
    expect(text).toContain('<QUOTED_TRANSCRIPT>\nquoted lines\n</QUOTED_TRANSCRIPT>')
    // The ask must not read as part of the quote.
    expect(text.endsWith('</QUOTED_TRANSCRIPT>\n\nexplain this')).toBe(true)
  })

  it('works with no message typed', () => {
    const text = transcriptQuotePromptText({ text: 'only a quote', truncated: false }, '   ')
    expect(text.endsWith('</QUOTED_TRANSCRIPT>')).toBe(true)
  })

  it('marks a truncated quote in the prompt', () => {
    const text = transcriptQuotePromptText({ text: 'cut', truncated: true }, 'go on')
    expect(text).toContain('…(quote truncated at the length limit)')
  })
})

describe('splitTranscriptQuoteMessage', () => {
  it('round-trips the quote and the user words', () => {
    const composed = transcriptQuotePromptText({ text: 'line one\nline two', truncated: false }, 'what does this mean')
    const parsed = splitTranscriptQuoteMessage(composed)
    expect(parsed?.quote.text).toBe('line one\nline two')
    expect(parsed?.quote.truncated).toBe(false)
    expect(parsed?.message).toBe('what does this mean')
  })

  it('round-trips a truncated quote without leaving the marker in the text', () => {
    const composed = transcriptQuotePromptText({ text: 'short', truncated: true }, '')
    const parsed = splitTranscriptQuoteMessage(composed)
    expect(parsed?.quote.text).toBe('short')
    expect(parsed?.quote.truncated).toBe(true)
    expect(parsed?.message).toBe('')
  })

  it('returns null for an ordinary message', () => {
    expect(splitTranscriptQuoteMessage('just a question')).toBeNull()
    expect(splitTranscriptQuoteMessage('')).toBeNull()
  })

  it('returns null for a half-written fence', () => {
    expect(splitTranscriptQuoteMessage('[quoted transcript] The user selected text in this conversation and quoted it below.\n<QUOTED_TRANSCRIPT>\nno close')).toBeNull()
  })

  it('keeps a quote that itself contains the closing marker from leaking the message', () => {
    // Defence in depth: a quote whose text contains the closing tag stops at
    // the first marker, so the rest reads as the user's own words rather than
    // being silently swallowed.
    const composed = transcriptQuotePromptText({ text: 'a\n</QUOTED_TRANSCRIPT>\nb', truncated: false }, 'tail')
    const parsed = splitTranscriptQuoteMessage(composed)
    expect(parsed).not.toBeNull()
    expect(parsed!.quote.text).toBe('a')
  })
})
