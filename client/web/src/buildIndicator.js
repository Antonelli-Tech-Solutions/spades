import { getBuildInfo } from './api.js'

export function createBuildIndicatorElement(commitShort) {
  if (!commitShort) return ''
  const safe = String(commitShort).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  return `<div id="build-indicator" style="position:fixed;bottom:4px;right:4px;font-size:11px;opacity:0.6;">${safe}</div>`
}

export async function renderBuildIndicator(fetchFn) {
  try {
    const { commitShort } = await getBuildInfo(fetchFn)
    return createBuildIndicatorElement(commitShort)
  } catch {
    return ''
  }
}
