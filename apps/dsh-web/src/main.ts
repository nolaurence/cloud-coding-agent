/**
 * Browser entry for the vendored DeepSeek Harness shell.
 *
 * The page is served by the CCA server at /dsh/: the server injects the boot
 * manifest and the plugin preloads that the per-user DSH host renders, then
 * this entry boots the official client module system against them.
 */
import '@deepseek-ai/dsh-client-ui-theme/brand-font.css'
import { AppWebEntry } from '@deepseek-ai/dsh-client-web'

const container = document.getElementById('root')
if (container === null) throw new Error('dsh web: missing #root')

// The stock layout bundle embeds the official product title. Keep the tab
// useful (session titles still prefix it) while presenting CCA's product name.
const PRODUCT_TITLE = 'Kloud Work'
const normalizeTitle = (): void => {
  const next = document.title.replaceAll('DeepSeek Harness', PRODUCT_TITLE)
  if (next !== document.title) document.title = next
}
const titleElement = document.querySelector('title')
if (titleElement !== null) {
  new MutationObserver(normalizeTitle).observe(titleElement, { childList: true, characterData: true, subtree: true })
}
normalizeTitle()

void new AppWebEntry(container).run()
