/**
 * Browser stand-in for `node:module`. The vendored Cordis loader imports
 * `createRequire` at module scope; boot never reaches the call in a browser.
 */

/** Fail if browser boot reaches Node's module loader. */
export const createRequire = (): never => {
  throw new Error('node:module is not available in the browser')
}

/** Type-only peer for the vendored loader. */
export type LoadHookContext = never
