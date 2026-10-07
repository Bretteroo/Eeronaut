import { useEffect, useMemo, type ReactNode } from 'react'
import { t } from '../i18n'

/* An address field shaped like the subnet it has to fit inside.
 *
 * A reservation has to be inside the LAN subnet, since eero refuses anything
 * outside it, so the mask already decides how much of the address is the
 * person's to choose. Each
 * octet is offered accordingly rather than as free text that gets rejected
 * afterward:
 *
 *   mask byte 255  the octet is fixed; shown, not editable
 *   mask byte 0    anything 0-255; a plain field
 *   anything else  only some values fit; a dropdown of exactly those
 *
 * So a /24 reads `192 . 168 . 1 . [__]` and a /22 reads
 * `192 . 168 . [4-7] . [__]`, which is the subnet stated as a shape rather
 * than as a sentence somebody has to read and apply.
 *
 * The network and broadcast addresses are left out of the last octet. They
 * cannot belong to a host, and offering them would be offering a value that
 * is certain to fail.
 */

export interface Subnet {
  cidr: string
  mask: string
  source: string
  /** False when the subnet was assumed and the assumption did not survive
   *  checking against the network. Nothing is constrained in that case. */
  certain: boolean
}

/** The values an octet may take, given the network address and mask byte. */
function allowed(base: number, maskByte: number): number[] {
  if (maskByte === 255) return [base]
  const out: number[] = []
  for (let v = 0; v < 256; v++) if ((v & maskByte) === (base & maskByte)) out.push(v)
  return out
}

/** The values a free octet may actually take, given the rest of the address.
 *
 *  0-255 in general, minus whatever would make the whole address the network
 *  or the broadcast address. Those two are not hosts, so the submit button
 *  already refuses them — the hint has to agree with the button or one of them
 *  is lying.
 *
 *  Which means the range is not fixed. On a /22 the last octet reads 1-255
 *  while the third octet sits at the bottom of the block (x.x.4.0 is the
 *  network), 0-254 at the top (x.x.7.255 is the broadcast), and 0-255 in
 *  between.
 */
export function freeRange(
  subnet: Subnet | null, parts: string[], i: number,
): { low: number; high: number } {
  if (!subnet?.certain) return { low: 0, high: 255 }
  /* Octets not yet filled in fall back to the network address rather than
     being left blank. An incomplete address is not a host, so every trial
     would fail and the hint would advertise the narrowest possible range —
     briefly, between the first render and the seeding effect, which is long
     enough to be seen and to be wrong. */
  const base = subnet.cidr.split('/')[0].split('.')
  const at = (v: number) => {
    const trial = [0, 1, 2, 3].map((n) =>
      n === i ? String(v) : (parts[n] || base[n] || '0'))
    return isHostIn(subnet, trial.join('.'))
  }
  return { low: at(0) ? 0 : 1, high: at(255) ? 255 : 254 }
}

export function SubnetAddress({ subnet, value, onChange, disabled }: {
  /** Null, or not `certain`, means a plain field: guessing at a subnet and
   *  then refusing an address that is actually valid would be worse than
   *  letting eero answer. */
  subnet: Subnet | null
  value: string
  onChange: (v: string) => void
  disabled?: boolean
}) {
  const shape = useMemo(() => {
    if (!subnet?.certain) return null
    const base = subnet.cidr.split('/')[0].split('.').map(Number)
    const mask = subnet.mask.split('.').map(Number)
    if (base.length !== 4 || mask.length !== 4 || base.some(isNaN)) return null

    const octets = base.map((b, i) => allowed(b, mask[i]))
    return { base, mask, octets }
  }, [subnet])

  const parts = value.split('.')
  const set = (i: number, v: string) => {
    const next = [0, 1, 2, 3].map((n) => (n === i ? v : (parts[n] ?? '')))
    onChange(next.join('.'))
  }

  /* Seeded to the first host address so the fixed octets are never blank —
     a field showing `. . . 50` with three empty boxes is not an address. */
  useEffect(() => {
    if (!shape || value.split('.').filter(Boolean).length === 4) return
    onChange(shape.base.map((b, i) => (i === 3 ? '' : String(b))).join('.'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape])

  if (!shape) {
    return (
      <input
        value={value} onChange={(e) => onChange(e.target.value)}
        disabled={disabled} required
        placeholder={t('network.ip_address')} aria-label={t('network.ip_address')}
        className="rounded-md border border-[var(--color-line-strong)]
                   bg-[var(--color-surface)] px-2 py-1.5 text-[13px]"
      />
    )
  }

  return (
    <div className="flex items-center gap-1" role="group"
         aria-label={t('network.ip_address')}>
      {shape.octets.map((choices, i) => {
        const label = t('network.octet_n', { n: String(i + 1) })

        /* Fixed by the mask. Rendered as text with a hidden input carrying the
           value, so the address still submits as one thing. */
        if (choices.length === 1) {
          return (
            <Group key={i} i={i}>
              <span className="px-1 font-mono text-[13px] text-[var(--color-ink-2)]"
                    aria-label={label}>{choices[0]}</span>
            </Group>
          )
        }

        /* Every value fits, so nothing is gained by listing them. The last
           octet drops the network and broadcast addresses. */
        if (choices.length === 256) {
          /* The range goes in the box rather than beside it. There are up to
             four of these and a legend under each would be more text than
             address — and the number somebody needs is the one for the box
             they are typing in. */
          const { low, high } = freeRange(subnet, parts, i)
          return (
            <Group key={i} i={i}>
              <input
                value={parts[i] ?? ''} onChange={(e) => set(i, e.target.value)}
                disabled={disabled} required inputMode="numeric"
                pattern="\d{1,3}" maxLength={3} aria-label={label}
                placeholder={`${low}-${high}`}
                title={t('network.octet_range', { low: String(low),
                                                  high: String(high) })}
                className="w-[4.5rem] rounded-md border border-[var(--color-line-strong)]
                           bg-[var(--color-surface)] px-2 py-1.5 text-center
                           font-mono text-[13px]"
              />
            </Group>
          )
        }

        return (
          <Group key={i} i={i}>
            <select
              value={parts[i] ?? String(choices[0])}
              onChange={(e) => set(i, e.target.value)}
              disabled={disabled} aria-label={label}
              className="rounded-md border border-[var(--color-line-strong)]
                         bg-[var(--color-surface)] px-1.5 py-1.5 font-mono text-[13px]"
            >
              {choices.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </Group>
        )
      })}
    </div>
  )
}

/** An octet and the dot after it. The dot belongs between the boxes rather
 *  than inside them, so the row reads as an address. */
function Group({ i, children }: { i: number; children: ReactNode }) {
  return (
    <>
      {children}
      {i < 3 && <span className="text-[13px] text-[var(--color-ink-3)]">.</span>}
    </>
  )
}

/** Whether an address is a usable host inside this subnet.
 *
 *  Exported because the form needs the same answer to decide whether to allow
 *  submission, and two implementations of one rule would eventually disagree.
 */
export function isHostIn(subnet: Subnet | null, value: string): boolean {
  const parts = value.split('.')
  if (parts.length !== 4) return false
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN))
  if (nums.some((n) => isNaN(n) || n > 255)) return false
  if (!subnet?.certain) return true          // nothing to check it against

  const [addr, bits] = subnet.cidr.split('/')
  const base = addr.split('.').map(Number)
  const mask = subnet.mask.split('.').map(Number)
  const asInt = (o: number[]) => o.reduce((a, b) => a * 256 + b, 0)
  const size = 2 ** (32 - Number(bits))
  const netInt = asInt(base)
  const ipInt = asInt(nums)

  if (nums.some((n, i) => (n & mask[i]) !== (base[i] & mask[i]))) return false
  // The network and broadcast addresses are not hosts.
  return ipInt !== netInt && ipInt !== netInt + size - 1
}

/**
 * An address inside the subnet that nothing is known to be using.
 *
 * A device with no lease has no address to pin, and offering empty octets
 * asks somebody to invent one and then find out whether it collided.
 * Reported from use. This answers instead, from what the page already knows:
 * every address a client currently holds and every address already reserved.
 *
 * Searched from the bottom of the subnet upwards, so the address offered is
 * the lowest one free — .2, then .3, and so on. Reservations end up in a run
 * near the start of the range rather than scattered at the top, which is how
 * most people keep them and how they read in a sorted list.
 *
 * Every address the page knows to be in use is skipped, which is every
 * client's current one and every existing reservation. A lease this app
 * cannot see — a device switched off today and back tomorrow — is the case
 * this cannot rule out either way; eero holds the reservation for this device
 * regardless, and the address it displaces would be re-leased elsewhere.
 *
 * Empty when the subnet is not established, since then there is nothing to
 * search and nothing to promise. A /8 is bounded too: 16 million candidates
 * is not a search anybody is waiting for, and the answer is always near the
 * end anyway.
 */
export function firstFreeAddress(subnet: Subnet | null,
                                 taken: (string | null | undefined)[]): string {
  if (!subnet?.certain) return ''
  const [addr, bits] = subnet.cidr.split('/')
  const width = Number(bits)
  if (!Number.isFinite(width) || width < 16) return ''
  const base = addr.split('.').map(Number)
  if (base.length !== 4 || base.some((n) => !Number.isFinite(n))) return ''

  const asInt = (o: number[]) => o.reduce((a, b) => a * 256 + b, 0)
  const asText = (n: number) =>
    [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
  const used = new Set(
    taken.map((v) => (v ?? '').trim()).filter(Boolean))

  const netInt = asInt(base)
  const size = 2 ** (32 - width)
  // From the first host up to the last, skipping the network address and the
  // broadcast — isHostIn refuses both, and so does eero.
  for (let n = netInt + 1; n < netInt + size - 1; n++) {
    const candidate = asText(n)
    if (used.has(candidate)) continue
    if (!isHostIn(subnet, candidate)) continue
    return candidate
  }
  return ''
}
