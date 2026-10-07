# Translating Eeronaut

One file per locale, next to this one. `en-US.json` is the source; every other
file is a copy of it with the values replaced.

    en-US.json   English (US), the source
    cs-CZ.json   Czech                  pl-PL.json   Polish
    da-DK.json   Danish                 pt-BR.json   Portuguese (Brazil)
    de-DE.json   German                 pt-PT.json   Portuguese (Portugal)
    es-ES.json   Spanish                fi-FI.json   Finnish
    fr-FR.json   French                 sv-SE.json   Swedish
    it-IT.json   Italian                uk-UA.json   Ukrainian
    hu-HU.json   Hungarian              ja-JP.json   Japanese
    nl-NL.json   Dutch                  ko-KR.json   Korean
    nb-NO.json   Norwegian Bokmål       zh-CN.json   Chinese (Simplified)
                                        zh-TW.json   Chinese (Traditional)

## Locales

A file is named for a BCP 47 tag, language and region: `es-ES`, `pt-BR`,
`zh-TW`. A reader asking for a region we do not have still gets their
language: `es-MX` reads `es-ES`, `fr-CA` reads `fr-FR`, and anything with no
match at all reads the source.

Portuguese and Chinese each ship twice because the difference is real:
Brazilian and European Portuguese differ in vocabulary and address, and
`zh-CN` is simplified characters where `zh-TW` is traditional. The script
forms and the other Chinese regions (`zh-Hans`, `zh-Hant`, `zh-HK`, `zh-SG`)
are mapped to the right one, and Norwegian `no` and `nn` read Bokmål. A
locale never borrows from a sibling: `zh-TW` will not fall back to `zh-CN`,
nor `pt-PT` to `pt-BR`.

## Adding a language

1. Copy `en-US.json` to your tag, language and region: `ro-RO.json`.
2. Replace the values. Leave the keys alone.
3. Add one entry to `LOCALES` in `locales.ts` and one line to `LOADERS` in
   `index.tsx`.

There is no build step for the catalog and no tooling to install.

## Rules

**Never translate a key.** The left-hand side is an address, not text.

**Keep everything in braces.** `{name}`, `{count}`, `{link}` are holes the app
fills in. They can move anywhere in the sentence — that is the point of them —
but a hole you delete leaves the sentence with a gap, and one you rename never
gets filled.

Word order is yours to choose. This is why the app does not build sentences by
sticking fragments together:

    "network.move_reservation_ip_device_keeps":
      "Move this reservation to {ip}?\n\nThe device keeps its current address…"

**`\n` is a real line break** and always deliberate. In a confirmation dialog
it separates the question from its consequences.

**Plurals have a key per form.** Every catalog has `.one` and `.other`, both
with `{count}`:

    "device_tree.clients.one":   "{count} client"
    "device_tree.clients.other": "{count} clients"

A language with more forms adds them: Czech, Polish, and Ukrainian also have
`.few` and `.many` for every plural. Which one a count takes is decided by the
browser's `Intl.PluralRules` for the language, so nothing else needs
changing. Japanese, Korean, and Chinese have one form; give `.one` and `.other`
the same text.

**A key you skip falls back to English.** A half-finished language gives a
half-translated interface, not a screen of dotted identifiers, so there is no
need to finish before you commit.

## Checking your work

Four checks need no browser at all and catch the mistakes that are otherwise
invisible: a key you missed, a key you typo'd (which silently does nothing), a
`{hole}` that changed name, and a plural missing its pair. Open an issue if you
want the suite that runs them — it is kept outside this repository, since a
test only means something beside the checkout it was written against.

## Two traps

**Never call `t()` in a module-level literal.** It runs once, at import, before
any language is in force, so whatever English it returns is frozen there for
the life of the page. Column arrays, label maps, and option lists are the usual
victims:

    const MODE_LABEL = { wpa2: t('network.wpa2_only') }        // frozen
    const MODE_LABEL = () => ({ wpa2: t('network.wpa2_only') }) // fine

This one is nasty because the key and the translation both exist, so every
consistency check passes and the screen is still English.

**`.ts` files count too.** The extractor globbed `.tsx` and missed
`lib/wan.ts`, which held the entire WAN outage diagnosis — about forty strings,
in the one place a reader most needs their own language.

**A third one, found by a bug report rather than by any check:** the page-walk
oracle only sees what a page renders on arrival. The 46 device-type labels in
`lib/deviceTypes.ts` sat untranslated behind the client drawer, which the walk
never opens. Anything reachable only through a drawer, a dialog, or a listbox
needs a test that opens it rather than one that waits for it to appear.

Watch for a local variable named `t` while you are in here. A `.map((t, i) =>`
or a parameter called `t` shadows the translate function, and the shadow is
silent until someone adds a call inside that scope. Three of them were found
this way.

A browser test catches the first two. It walks every page in Hungarian and
fails if any string that *has* a translation rendered in English. Source
scanners could not see either problem; the rendered page sees both.

## What is not translated yet

A handful of long confirmation dialogs are still assembled from several pieces
in the source and have to be restructured before they can be keyed at all.
They are English in every language for now. Converting one means replacing the
concatenation with a single `t('key', { … })` call and adding the key to
`en-US.json`.

## Conventions used in Spanish

Formal *usted* throughout, since this is an interface that reboots hardware and
changes firewall rules. Technical terms that Spanish networking documentation
leaves in English stay in English — Wi-Fi, DNS, DHCP, PPPoE, WPA3, Thread,
Matter, firmware, hardware. Terms with settled Spanish equivalents use them:
*puerta de enlace*, *cortafuegos*, *red de invitados*, *reenvío de puertos*.

## Never prune a catalog by searching the source for its keys

The obvious test for a dead key — "does this string appear anywhere in `src/`?"
— is wrong, and wrong in the most expensive direction. A large minority of keys
are assembled at runtime:

    t(`device_type.${type}`)     t(`wan.${state}.next${i}`)
    t(`day.${d}.short`)          t(`clients.filter_${f}`)
    tOr(`filter_level.${l.id}`, l.title)

None of those keys can be found by grepping for themselves, so every one of
them looks orphaned. A sweep built on that test deleted 156 keys per language in
one pass, including all 46 device types, the entire WAN outage ladder, the day
abbreviations, and the Matter responsiveness bands. English came back out of the
APK string table and the source fallbacks; eero ships Spanish, so those returned
too; Hungarian had to be written again from scratch.

So a key is dead only when nothing reaches it by *any* of the three routes:
written out in full, built from a stem at run time, or named by its plural stem.
Removing one means checking all three. When a change stops using a string,
delete it then — from every catalog, in that same change — rather than leaving
it for a sweep that cannot tell an orphan from a key it simply cannot see.
