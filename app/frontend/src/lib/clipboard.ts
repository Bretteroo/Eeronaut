/**
 * Copy text, including where the clipboard API is not allowed.
 *
 * `navigator.clipboard` exists only in a secure context. Eeronaut's normal
 * deployment is plain HTTP on a LAN — a container on a home network, reached
 * by address — where the property is simply not there, so calling it throws
 * and any `catch` around it turns the button into one that does nothing and
 * says nothing. That is what "Copy link" did.
 *
 * The fallback is the old selection trick, which needs no permission and works
 * anywhere a user gesture is in progress. It is deprecated and it is also the
 * only thing available here.
 *
 * Returns whether the text actually reached the clipboard, so a caller can say
 * something useful when it did not rather than pretending it worked.
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* Refused, or unavailable after all. The fallback below still might. */
  }
  try {
    const box = document.createElement('textarea')
    box.value = text
    // Off-screen but selectable: `display: none` cannot be selected, and a
    // visible one would flash.
    box.setAttribute('readonly', '')
    box.style.position = 'fixed'
    box.style.top = '-1000px'
    box.style.opacity = '0'
    document.body.appendChild(box)
    box.select()
    box.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(box)
    return ok
  } catch {
    return false
  }
}
