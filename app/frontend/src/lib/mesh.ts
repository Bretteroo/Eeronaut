/* Working out which eero meshes to which.

   eero reports a wireless uplink as `node_or_proxied_node_id`. That is a node
   id, from a different identifier space than the one in the eero's own URL,
   and it appears nowhere else on the eero object — so comparing the two never
   matches and every wirelessly-meshed node looked parentless. On a network
   where the leaves are cabled that goes unnoticed; on one where they are not,
   they vanished from the map entirely.

   The same block carries the parent's name, which does match, and is what the
   phone app shows too. */

export interface MeshNode {
  location?: string
  gateway?: boolean
  wireless_upstream_node?: {
    name?: string | null
    node_or_proxied_node_id?: string | number | null
  } | null
}

/** The name of the eero this one meshes to, or null when it is wired or is
 *  itself the gateway. */
export function uplinkName(e: MeshNode): string | null {
  const n = e.wireless_upstream_node?.name
  return typeof n === 'string' && n.trim() ? n.trim() : null
}

/** Whether `child` meshes wirelessly to `parent`. */
export function meshesTo(child: MeshNode, parent: MeshNode): boolean {
  const up = uplinkName(child)
  return Boolean(up && parent.location && up === parent.location)
}

/** Whether anything in `eeros` is the named parent of `child`. A node whose
 *  uplink names an eero we cannot find must still be drawn somewhere, so the
 *  callers hang those off the gateway rather than dropping them. */
export function hasKnownUplink(child: MeshNode, eeros: MeshNode[]): boolean {
  const up = uplinkName(child)
  return Boolean(up && eeros.some((e) => e.location === up))
}
