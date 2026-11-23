/**
 * Favicon URLs are page-authored data: a hostile page controls
 * `chrome.tabs.Tab.favIconUrl` and may hand the panel anything it likes,
 * including `javascript:`, `blob:`, `filesystem:` or an oversized data URL.
 *
 * The panel renders the value into an `<img src>`, so the only safe admission
 * is a scheme an image can come from and no more. This module is the single
 * gate; callers must not render a raw value even when it came from our own
 * service worker, because the around-the-houses path through session storage
 * and a worker restart should not widen what the renderer will accept.
 *
 * @module
 */

/** A favicon is a small icon; anything larger is not one. */
const MAX_FAVICON_URL_CHARS = 65_536

/**
 * `data:image/...` payloads are allowed for the raster and icon formats Chrome
 * commonly inlines. SVG is permitted because `<img>` renders it as a static
 * image with no script execution and no outbound fetches.
 */
const ALLOWED_DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml)[;,]/i

/**
 * Narrow a page-authored favicon URL to something an `<img>` may load.
 * @param value - the raw `favIconUrl` from a tab, or anything else.
 * @returns an `http:`, `https:` or safe `data:image/...` URL, else undefined.
 */
export function normalizeFaviconUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > MAX_FAVICON_URL_CHARS) return undefined
  // A data URL is checked by prefix, never parsed: parsing megabytes of base64
  // to reject it is the wrong trade.
  if (/^data:/i.test(trimmed)) return ALLOWED_DATA_IMAGE.test(trimmed) ? trimmed : undefined
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    // Credentials in a favicon URL serve no purpose and leak into logs.
    return url.username === '' && url.password === '' ? url.href : undefined
  } catch {
    return undefined
  }
}
