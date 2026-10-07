import { t } from '../i18n'

/**
 * Asking before a change that restarts the mesh.
 *
 * One tier, because there is only one kind of answer worth giving: this
 * setting restarts your network, and here is what that costs.
 *
 * There were two. `may` covered the settings nothing had established either
 * way — eero says nothing about them and nobody had watched one — on the
 * principle that "nothing warned me" is not evidence a setting is safe. The
 * uplink VLAN tag is what settles that argument: eero never mentions it and a
 * wrong tag takes the connection down irrecoverably.
 *
 * It was scaffolding with an exit condition, and it exited. All six were
 * tested by hand on 2026-09-03 and none of them restart the mesh, so the tier
 * is gone rather than sitting empty. A permanent "this might cost you the
 * network" would have been an admission the question was never answered, and
 * it teaches people to click through the dialog that does matter.
 *
 * Which setting restarts the mesh was established by changing one at a
 * time on live hardware and watching what happened, not by assumption.
 *
 * One sentence about the consequence, deliberately: somebody deciding whether
 * to press the button cares that the network goes away for several minutes.
 * Measured at four and a half to six minutes on a six-node mesh, against
 * eero's own claim of about one.
 */
/** The question to put in front of somebody, given what they are changing.
 *
 *  `also` is for a setting that costs something beyond the restart — MLO
 *  turns WPA3 on with it, which is eero's own warning and not a thing to
 *  find out afterward. It sits between the restart and its consequence so
 *  the question still ends on the question. */
export function rebootWarning(what: string, also?: string): string {
  return t('reboot.confirm_will', { what })
    + (also ? '\n\n' + also : '')
    + '\n\n' + t('reboot.consequence')
}

/**
 * Ask, and report whether to go ahead.
 *
 * `window.confirm` because that is what every other destructive action in this
 * app already uses, and a bespoke dialog here would be the only one of its
 * kind.
 */
export function confirmReboot(what: string, also?: string): boolean {
  return window.confirm(rebootWarning(what, also))
}
