import { useEffect, useRef, useState } from 'react'

export interface LiveNode {
  serial: string
  mac: string
  firmware: string
  wan_v4: string
  lan_v4: string
  wan_v6: string
  lan_v6: string
  at: number
}

export interface LiveState {
  connected: boolean
  source: string
  nodes: Record<string, LiveNode>
  warning: string
}

/**
 * Subscribes to the local status stream, which is backed by a gRPC
 * server-streaming RPC to the hardware. Updates arrive when something actually
 * changes, so there is no polling interval and no cloud round-trip.
 *
 * EventSource reconnects on its own, but only for transport-level drops; a
 * server-side 503 closes the stream for good, so that case is surfaced rather
 * than retried forever.
 */
export function useLiveStatus(enabled: boolean): LiveState {
  const [state, setState] = useState<LiveState>({
    connected: false, source: '', nodes: {}, warning: '',
  })
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => {
    if (!enabled) return
    const es = new EventSource('/api/local/stream')
    esRef.current = es

    es.addEventListener('open', (e) => {
      const d = JSON.parse((e as MessageEvent).data)
      setState((s) => ({ ...s, connected: true, source: d.source, warning: '' }))
    })
    es.addEventListener('status', (e) => {
      const n = JSON.parse((e as MessageEvent).data) as LiveNode
      setState((s) => ({ ...s, connected: true, nodes: { ...s.nodes, [n.serial]: n } }))
    })
    es.addEventListener('warn', (e) => {
      const d = JSON.parse((e as MessageEvent).data)
      setState((s) => ({ ...s, warning: d.detail ?? '' }))
    })
    es.onerror = () => setState((s) => ({ ...s, connected: false }))

    return () => { es.close(); esRef.current = null }
  }, [enabled])

  return state
}

export const isOnline = (v: string) => v.endsWith('_ONLINE')
