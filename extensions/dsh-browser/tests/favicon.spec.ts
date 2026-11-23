// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { normalizeFaviconUrl } from '../src/security/favicon.ts'

/**
 * `chrome.tabs.Tab.favIconUrl` is page-authored. These cases are the contract
 * the panel depends on before it puts the value into an `<img src>`.
 */
describe('favicon URL admission', () => {
  it('accepts plain web icons', () => {
    expect(normalizeFaviconUrl('https://example.com/favicon.ico')).toBe('https://example.com/favicon.ico')
    expect(normalizeFaviconUrl('http://example.com/i.png')).toBe('http://example.com/i.png')
    expect(normalizeFaviconUrl('  https://example.com/a.svg  ')).toBe('https://example.com/a.svg')
  })

  it('accepts only image data URLs', () => {
    expect(normalizeFaviconUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
    expect(normalizeFaviconUrl('data:image/svg+xml,<svg/>')).toBe('data:image/svg+xml,<svg/>')
    expect(normalizeFaviconUrl('data:image/x-icon;base64,AAAA')).toBe('data:image/x-icon;base64,AAAA')
  })

  it('rejects every scheme an image cannot safely come from', () => {
    for (const value of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'data:application/javascript,alert(1)',
      'blob:https://example.com/xyz',
      'filesystem:https://example.com/temporary/x',
      'file:///C:/secret.png',
      'chrome://favicon/',
      'vbscript:msgbox(1)',
    ]) {
      expect(normalizeFaviconUrl(value)).toBeUndefined()
    }
  })

  it('rejects non-strings, blanks and oversized payloads', () => {
    expect(normalizeFaviconUrl(undefined)).toBeUndefined()
    expect(normalizeFaviconUrl(null)).toBeUndefined()
    expect(normalizeFaviconUrl(42)).toBeUndefined()
    expect(normalizeFaviconUrl({ src: 'https://example.com/i.png' })).toBeUndefined()
    expect(normalizeFaviconUrl('')).toBeUndefined()
    expect(normalizeFaviconUrl('   ')).toBeUndefined()
    expect(normalizeFaviconUrl('not a url')).toBeUndefined()
    expect(normalizeFaviconUrl(`data:image/png;base64,${'A'.repeat(70_000)}`)).toBeUndefined()
  })

  it('drops embedded credentials', () => {
    expect(normalizeFaviconUrl('https://user:pass@example.com/i.png')).toBeUndefined()
    expect(normalizeFaviconUrl('https://user@example.com/i.png')).toBeUndefined()
  })

  it('normalizes the URL it returns', () => {
    expect(normalizeFaviconUrl('HTTPS://Example.COM/i.png')).toBe('https://example.com/i.png')
  })
})
