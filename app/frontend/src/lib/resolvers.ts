/**
 * The public resolvers this app offers, and how to name them.
 *
 * Lifted out of `pages/Network.tsx` when the connection-information panel
 * moved to the dashboard. That panel names the resolver a network is pointed
 * at, so `resolverFor` had to be reachable from two pages; the table it reads
 * is data rather than page code and belongs here either way.
 *
 * Everything below is unchanged from where it lived before, including the
 * sourcing notes on the table itself.
 */
import { t, tOr } from '../i18n'

export interface Resolver {
  id: string
  label: string
  /** A variant of the provider above it. Indented in the list. */
  nested?: boolean
  /* Only set where there is evidence, and undefined means "not claimed"
     rather than "not supported". Most flags come from the provider's own
     documentation, including Quad9's plain resolver, which its source labels
     as doing no DNSSEC validation, and AdGuard, which says it supports DNSSEC.

     Control D, Comodo, and Level3 document neither, so theirs were measured
     instead (September 2026). A resolver that validates answers SERVFAIL for
     dnssec-failed.org, whose signatures are deliberately broken, and sets the
     AD flag on a signed name; Control D does both, Comodo and Level3 neither.
     Google's o-o.myaddr.l.google.com TXT record reports any client subnet a
     resolver passes on, and none of the three passed one.

     AdGuard does send ECS, but not the client's subnet: its January 2024 post
     on the subject describes a stand-in subnet from roughly the same area,
     and the measured one was a different /24 from the one Google saw. The
     ECS note says part of the client's own address is passed on, which would
     be false here, so AdGuard carries no ECS mark. */
  dnssec?: boolean
  ecs?: boolean
  /** A key into the summaries below, on the top-level entry for each provider.
   *  Nested variants inherit their parent's. */
  about?: string
  /** The resolver declines to answer for domains on a blocklist. Set from the
   *  provider's own description of the product: Quad9's two filtered addresses
   *  are documented as filtered, and AdGuard, Cloudflare, and Control D say
   *  plainly what each of their variants blocks. */
  filtered?: boolean
  v4: string[]
  v6: string[]
}

/* Sorted by provider name, with each provider's variants kept under it: a
   variant sorted away from its parent — "Family protection" filed under F —
   is a name with no owner. "Custom" is pinned first by the picker, not by this
   list, since it is not a resolver.

   Written in order rather than sorted at runtime, because the variants have to
   follow their parent and nothing in the data says which parent a variant
   belongs to; the order *is* that relationship. */
export const RESOLVERS: Resolver[] = [
  { id: 'adguard', about: 'adguard', dnssec: true, label: 'AdGuard DNS',
    v4: ['94.140.14.140', '94.140.14.141'],
    v6: ['2a10:50c0::1:ff', '2a10:50c0::2:ff'] },
  { id: 'adguard-blocking', nested: true, filtered: true, dnssec: true,
    label: 'Blocks ads and trackers',
    v4: ['94.140.14.14', '94.140.15.15'],
    v6: ['2a10:50c0::ad1:ff', '2a10:50c0::ad2:ff'] },
  { id: 'adguard-family', nested: true, filtered: true, dnssec: true,
    label: 'Family protection',
    v4: ['94.140.14.15', '94.140.15.16'],
    v6: ['2a10:50c0::bad1:ff', '2a10:50c0::bad2:ff'] },

  { id: 'cloudflare', about: 'cloudflare', dnssec: true, label: 'Cloudflare',
    v4: ['1.1.1.1', '1.0.0.1'],
    v6: ['2606:4700:4700::1111', '2606:4700:4700::1001'] },
  { id: 'cloudflare-malware', nested: true, filtered: true, dnssec: true,
    label: 'For Families — blocks malware',
    v4: ['1.1.1.2', '1.0.0.2'],
    v6: ['2606:4700:4700::1112', '2606:4700:4700::1002'] },
  { id: 'cloudflare-family', nested: true, filtered: true, dnssec: true,
    label: 'For Families — blocks malware and adult content',
    v4: ['1.1.1.3', '1.0.0.3'],
    v6: ['2606:4700:4700::1113', '2606:4700:4700::1003'] },

  { id: 'comodo', about: 'comodo', dnssec: false, ecs: false, label: 'Comodo',
    v4: ['8.26.56.26', '8.20.247.20'],
    v6: ['2001:5a60::ad1:0ff', '2001:5a60::ad2:0ff'] },
  /* The free resolvers from https://controld.com/free-dns, the five its
     quick setup offers. Addresses from Control D's free DNS documentation. */
  { id: 'controld', about: 'controld', dnssec: true, ecs: false, label: 'Control D',
    v4: ['76.76.2.0', '76.76.10.0'],
    v6: ['2606:1a40::0', '2606:1a40:1::0'] },
  { id: 'controld-malware', nested: true, filtered: true, dnssec: true, ecs: false,
    label: 'Blocks malware',
    v4: ['76.76.2.1', '76.76.10.1'],
    v6: ['2606:1a40::1', '2606:1a40:1::1'] },
  { id: 'controld-ads', nested: true, filtered: true, dnssec: true, ecs: false,
    label: 'Blocks ads and trackers',
    v4: ['76.76.2.2', '76.76.10.2'],
    v6: ['2606:1a40::2', '2606:1a40:1::2'] },
  { id: 'controld-social', nested: true, filtered: true, dnssec: true, ecs: false,
    label: 'Blocks ads, trackers, and social media',
    v4: ['76.76.2.3', '76.76.10.3'],
    v6: ['2606:1a40::3', '2606:1a40:1::3'] },
  { id: 'controld-family', nested: true, filtered: true, dnssec: true, ecs: false,
    label: 'Family friendly',
    v4: ['76.76.2.4', '76.76.10.4'],
    v6: ['2606:1a40::4', '2606:1a40:1::4'] },
  { id: 'google', about: 'google', dnssec: true, ecs: true, label: 'Google Public DNS (ECS, DNSSEC)',
    v4: ['8.8.8.8', '8.8.4.4'],
    v6: ['2001:4860:4860::8888', '2001:4860:4860::8844'] },
  { id: 'level3', about: 'level3', dnssec: false, ecs: false, label: 'Level3',
    v4: ['4.2.2.1', '4.2.2.2'],
    v6: ['2001:4:112::1', '2001:4:112::2'] },
  { id: 'opendns', about: 'opendns', dnssec: true, ecs: true, label: 'OpenDNS (ECS, DNSSEC)',
    v4: ['208.67.222.222', '208.67.220.220'],
    v6: ['2620:119:35::35', '2620:119:53::53'] },
  { id: 'quad9', about: 'quad9', dnssec: false, label: 'Quad9',
    v4: ['9.9.9.10', '149.112.112.10'],
    v6: ['2620:fe::10', '2620:fe::fe:10'] },
  { id: 'quad9-filtered', nested: true, filtered: true, dnssec: true,
    label: 'Blocks malicious domains',
    v4: ['9.9.9.9', '149.112.112.112'],
    v6: ['2620:fe::fe', '2620:fe::9'] },
  { id: 'quad9-ecs', nested: true, filtered: true, dnssec: true, ecs: true,
    label: 'Blocks malicious domains',
    v4: ['9.9.9.11', '149.112.112.11'],
    v6: ['2620:fe::11', '2620:fe::fe:11'] },

]

/* A select cannot make an optgroup label selectable, and the parent here has to
   be pickable — it is a resolver in its own right. So the nesting is drawn with
   leading spaces in the option text, which is what every other list that needs
   a selectable parent does. */
/* "For Families — blocks malware" on its own does not say whose. The parent's
   name is prepended for anything that needs to stand alone: a confirmation
   dialog, a sentence about what is in force. */
export const fullName = (r: Resolver) => {
  if (!r.nested) return cleanLabel(r)
  const i = RESOLVERS.indexOf(r)
  for (let j = i - 1; j >= 0; j--) {
    if (!RESOLVERS[j].nested) {
      return `${cleanLabel(RESOLVERS[j])} — ${cleanLabel(r)}`
    }
  }
  return cleanLabel(r)
}

/* What a resolver does, as marks rather than words in its name.

   The published names are inconsistent — "Google Public DNS (ECS, DNSSEC)"
   spells both out, "Cloudflare" spells out neither, AdGuard's variants describe
   what they block without calling it filtering — so reading the list told you
   about one resolver's properties and not the next one's. Appending the missing
   words made every entry declare the same things, but it also made the list a
   wall of parentheses, and the terms already in a name still read differently
   from the ones added after it.

   As marks they line up in a column instead, so the list can be scanned down
   for "which of these filters" without reading a single name. Which is also why
   this needs a listbox rather than a select: an <option> holds text and nothing
   else. */
const TERMS: [keyof Resolver, string, string][] = [
  ['filtered', 'network.term_filtered', 'Filtered'],
  ['ecs', '', 'ECS'],
  ['dnssec', '', 'DNSSEC'],
]

/* The name with the terms stripped back out. Some published labels wrote them
   in, and printing "(ECS, DNSSEC)" beside two marks saying the same thing is
   the duplication this replaced. */
export const cleanLabel = (r: Resolver) =>
  /* Translated here because every display of a resolver's name comes through
     this function. Only the variants have translations: a parent's label is a
     product name — AdGuard DNS, Quad9 — and translating those would rename
     somebody's service. The variants are descriptions of what they do, which is
     a different kind of string entirely. */
  tOr(`resolver.${r.id}`, r.label)
    .replace(/\s*\((?:ECS|DNSSEC|Filtered)(?:,\s*(?:ECS|DNSSEC|Filtered))*\)\s*$/i, '')
    .trim()

export const termsOf = (r: Resolver) =>
  TERMS.filter(([flag]) => r[flag])
    .map(([, key, word]) => (key ? tOr(key, word) : word))

/* The notes, in the order the resolver's own name lists them.
   The published labels read "Google Public DNS (ECS, DNSSEC)" and "Quad9 —
   Filtered, ECS, DNSSEC", so ECS comes first and the explanation under it
   should too; fixing the order in code meant the list and the label disagreed
   with each other on the same screen. Anything a label does not spell out sorts
   last, which is how Cloudflare's DNSSEC lands — it is a property of the
   resolver rather than part of its published name.

   `indexOf('ECS')` does not collide with DNSSEC: that ends "SEC", not "ECS". */
/* The notes, in the order the marks are drawn — Filtered, ECS, DNSSEC — so the
   list of explanations reads down in the same order as the row above it. */
export const notesFor = (r: Resolver): (keyof Resolver)[] =>
  TERMS.map(([flag]) => flag).filter((flag) => r[flag])



/* One sentence on who runs each resolver.

   Who operates a resolver is the thing a person weighs before pointing their
   whole network at it, and it is the one fact neither the address nor the
   marks carry. Deliberately about operators and lineage rather than policy: I
   can say who runs Quad9 and that Cisco owns OpenDNS, and those hold up. Claims
   about what a provider does with query data would not — those change, and a
   stale privacy claim in an interface is worse than none.

   Nested variants inherit their parent's sentence: the variant's own label
   already says what it blocks. */
export const ABOUT = (): Record<string, string> => ({
  adguard: t('network.about_adguard'),
  cloudflare: t('network.about_cloudflare'),
  comodo: t('network.about_comodo'),
  controld: t('network.about_controld'),
  google: t('network.about_google'),
  level3: t('network.about_level3'),
  opendns: t('network.about_opendns'),
  quad9: t('network.about_quad9'),
})

export const aboutFor = (r: Resolver): string | null => {
  const i = RESOLVERS.indexOf(r)
  for (let j = i; j >= 0; j--) {
    const key = RESOLVERS[j].about
    if (key) return ABOUT()[key] ?? null
    if (!RESOLVERS[j].nested && j !== i) break
  }
  return null
}

/* The provider a set of addresses belongs to, at the top level.

   Which of Cloudflare's three a network is pointed at is a detail for the DNS
   pane; on the Internet card the useful fact is "Cloudflare". So a nested match
   reports its parent, and anything unrecognized is Custom — which is honest,
   since a resolver this app has never heard of is exactly that. */
export const resolverFor = (mode: string | undefined, v4: string[]) => {
  if (mode !== 'custom') return t('network.isp_dns')
  const want = v4.join(',')
  const i = RESOLVERS.findIndex((r) => r.v4.join(',') === want)
  if (i < 0) return t('network.dns_my_own')
  for (let j = i; j >= 0; j--) {
    if (!RESOLVERS[j].nested) return cleanLabel(RESOLVERS[j])
  }
  return cleanLabel(RESOLVERS[i])
}

