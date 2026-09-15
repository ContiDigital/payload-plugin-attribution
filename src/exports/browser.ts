export type { Attribution, ConsentState } from '../core/sanitize.js'
export { sanitizeAttribution } from '../core/sanitize.js'
export type { Touches } from '../core/touches.js'
export {
  attributionForSubmit,
  captureAttribution,
  consentDefaults,
  createEventId,
  trackClient,
} from '../web/browser.js'
export type { BrowserOptions } from '../web/browser.js'
