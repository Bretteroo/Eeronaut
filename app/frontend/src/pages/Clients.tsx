import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { api, ApiError, lastRead } from '../lib/api'
import { useRevalidate } from '../lib/revalidate'
import { CLIENTS_MS } from '../lib/pollRates'
import { Page, Card, DataTable, Drawer, EditableText, Notice, SignalBars, StatusDot, Toggle, WiredLink, useNotice, type Column, type State } from '../components/primitives'
import { clientBars, sortValue as signalSort } from '../lib/signal'
import { ClientDetail } from '../components/ClientDetail'
import { DeviceIcon } from '../components/DeviceIcon'
import { bandOf } from '../lib/format'
import { prefetchProfiles } from '../lib/profiles'
import { t } from '../i18n'

interface Device {
  url: string; mac?: string; ip?: string; nickname?: string | null
  hostname?: string | null; display_name?: string; manufacturer?: string
  connected?: boolean; wireless?: boolean; connection_type?: string
  paused?: boolean; blacklisted?: boolean; is_guest?: boolean; device_type?: string | null
  source?: { location?: string }
  connectivity?: { signal?: string; score_bars?: number; frequency?: number | null
                   ethernet_status?: { speed?: string | null
                                       interface_number?: number | null
                                       port_name?: string | null } | null }
  profile?: { name?: string } | null
}

type Filter = 'all' | 'online' | 'offline' | 'paused' | 'blocked'

export function Clients() {
  /* Opens on the last answer; the read below asks for a new one. */
  const [rows, setRows] = useState<Device[]>(
    () => lastRead<Device[]>('/api/devices') ?? [])
  /* Loaded from the start when there is a last answer to open on. Starting
     false drew the table's placeholder over rows already in hand, every time
     somebody came back to this page. */
  const [loaded, setLoaded] = useState(
    () => lastRead<Device[]>('/api/devices') !== undefined)
  const [blocked, setBlocked] = useState<Device[]>(
    () => lastRead<Device[]>('/api/devices/blocked') ?? [])
  const [reserved, setReserved] = useState<{ mac?: string }[]>([])
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [err, setErr] = useState('')
  const say = useNotice()
  const [detailKey, setDetailKey] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [selectedMac, setSelectedMac] = useState<string | null>(null)
  // Derived rather than snapshotted, so a rename in the drawer is
  // reflected in its own title.
  /* Both lists. A blocked client is not in `rows` at all — eero returns it
     from a separate endpoint — so looking it up here alone left every blocked
     row unopenable: the click registered, the lookup missed, and the drawer
     silently did not appear. */
  /* The client the global search handed over, if that is how we got here.
     It stands in until this page's own list arrives, which is what lets the
     drawer open in the same paint as the page rather than a fetch later. */
  const location = useLocation()
  const handed = (location.state as { client?: Device } | null)?.client ?? null

  const selected = selectedMac
    ? [...rows, ...blocked].find(
        (d) => (d.mac ?? '').toLowerCase() === selectedMac.toLowerCase())
      ?? ((handed?.mac ?? '').toLowerCase() === selectedMac.toLowerCase()
          ? handed : null)
    : null

  const load = useCallback(() => {
    api.get<Device[]>('/api/devices').then((d) => setRows(d ?? []))
      .catch((e) => setErr(e.message))
      // The count is left off the title until this resolves. `rows` starts
      // empty, so the header read "Clients (0)" for as long as the fetch
      // took — a claim that the network has no clients on it.
      .finally(() => setLoaded(true))
    api.get<Device[]>('/api/devices/blocked').then((d) => setBlocked(d ?? []))
      .catch(() => {})
    // Reservations are not carried on the device objects, so they come from
    // the network's own list and are matched by MAC.
    api.get<{ mac?: string }[]>('/api/reservations')
      .then((r) => setReserved(r ?? [])).catch(() => {})
  }, [])
  useEffect(load, [load])
  /* Clients come and go without anybody touching this page — a phone leaves,
     a console wakes up — and the table said whatever was true when it loaded.
     Ten seconds is eero's own rate for its clients list. */
  useRevalidate(load, CLIENTS_MS)
  // The client sidebar offers a profile dropdown; fetching the
  // list now means it is already there when one is opened.
  useEffect(prefetchProfiles, [])

  /* The global search jumps here with ?focus=<mac>; open that client's drawer,
     then clear the param so a refresh does not reopen it.

     A handed-over client opens straight away. Without one — someone pasting
     the URL, say — it waits for the list, because a mac that names nothing on
     this network should open nothing rather than an empty panel. */
  useEffect(() => {
    const mac = new URLSearchParams(window.location.search).get('focus')
    if (!mac) return
    const known = (handed?.mac ?? '').toLowerCase() === mac.toLowerCase()
      ? handed
      : rows.find((d) => (d.mac ?? '').toLowerCase() === mac.toLowerCase())
    if (!known) return
    setSelectedMac(known.mac ?? null)
    const url = new URL(window.location.href)
    url.searchParams.delete('focus')
    window.history.replaceState({}, '', url)
  /* The location's key as well: a link to ?focus= followed while this page is
     already open (a notification's "See details") is a new navigation to the
     same page, which changes nothing else this watches. */
  }, [rows, handed, location.key])

  const blockedMacs = useMemo(
    () => new Set(blocked.map((b) => (b.mac ?? '').toLowerCase())), [blocked])
  const reservedMacs = useMemo(
    () => new Set(reserved.map((r) => (r.mac ?? '').toLowerCase())), [reserved])

  /* Errors only, no confirmations. The success notice appeared above the table
     and pushed every row down the moment anybody paused a client, so the row
     they had just clicked jumped out from under the cursor — and it did that to
     report something the table itself already shows, since the status dot
     changes to a pause glyph in the same breath. A failure is the only outcome
     the table cannot show on its own. */
  const nameOf = (d: Device) =>
    d.nickname || d.hostname || d.display_name || d.mac || ''

  async function act<T>(key: string, fn: () => Promise<T>) {
    setBusy(key); say.clear()
    try { await fn(); load() }
    catch (e) {
      say.fail(e instanceof ApiError ? e.message : t('clients.did_not_work'))
      // Rethrown so the switch that started this snaps back. Swallowing it
      // left the toggle showing a state eero had refused.
      throw e
    }
    finally { setBusy(null) }
  }

  const pause = (d: Device) =>
    act(d.url, () => api.put(`/api/devices/${d.mac}/pause`, { paused: !d.paused }))

  function block(d: Device) {
    // No confirmation. Blocking is one switch away from being undone by the
    // same switch, so a dialog on every flip was a toll on a reversible act.
    const isBlocked = blockedMacs.has((d.mac ?? '').toLowerCase())
    return act(d.url,
        () => isBlocked
          ? api.del(`/api/devices/block/${d.mac}`)
          : api.post('/api/devices/block', { mac: d.mac }))
  }

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    // Blocked clients are not in the devices list at all — eero serves them
    // from a separate blacklist — so filtering the devices list for them
    // always came back empty. Show the blocklist itself instead.
    let list = filter === 'blocked' ? [...blocked] : [...rows]
    if (filter === 'online') list = list.filter((d) => d.connected)
    if (filter === 'offline') list = list.filter((d) => !d.connected)
    if (filter === 'paused') list = list.filter((d) => d.paused)
    if (!needle) return list
    return list.filter((d) =>
      [d.nickname, d.hostname, d.display_name, d.ip, d.mac, d.manufacturer]
        .some((v) => v?.toLowerCase().includes(needle)))
  }, [rows, blocked, q, filter])

  /** Whether this client is on ethernet.
   *
   *  `wireless: false` is not enough on its own: Sonos speakers on SonosNet
   *  report it while being no such thing, which is why eero also carries a
   *  connection type. The Connection column reads the same test, so the two
   *  cannot disagree about the same client. */
  const isWired = (d: Device) =>
    !d.wireless && (d.connection_type === 'wired'
                    || Boolean(d.connectivity?.ethernet_status?.speed))

  /** Pull the numeric RSSI out of eero's "-72 dBm" string.
   *
   *  Null for wired clients, which have no meaningful signal, and null for
   *  disconnected ones: eero freezes the last reading it took rather than
   *  clearing it, so every offline client keeps reporting whatever it had when
   *  it left — usually a full five bars. Showing that beside "Offline" states
   *  two contradictory things about the same client. */
  const rssi = (d: Device): number | null => {
    if (!d.wireless || !d.connected) return null
    const m = /-?\d+/.exec(d.connectivity?.signal ?? '')
    if (!m) return null
    const v = Number(m[0])
    return Number.isFinite(v) && v < 0 ? v : null
  }

  /** What the Connection column says, and so also what it sorts on.
   *
   *  A band only for a client that is on the network. eero keeps the last
   *  band it saw for a client that has gone, and sorting on that while
   *  drawing a plain "Wi-Fi" scattered the offline clients through the bands
   *  they used to be on: 2.4 GHz, then offline, then 5 GHz, then offline
   *  again. One function for both, so the two cannot disagree. */
  const connLabel = (d: Device): string | null => {
    if (!d.wireless) return isWired(d) ? t('device_tree.wired') : null
    const b = d.connected ? bandOf(d.connectivity?.frequency) : null
    return b ? t('clients.wifi_band', { band: b }) : 'Wi-Fi'
  }

  /** What eero reports about this client's link, in one place, so the column
   *  sorts on exactly what it draws. A wired or absent client has no link. */
  const link = (d: Device) => d.wireless && d.connected
    ? { rating: d.connectivity?.score_bars, dbm: rssi(d) }
    : null

  /** IPv4 as an integer, so .20 sorts before .100 rather than after it. */
  const ipKey = (ip?: string): number | null => {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip ?? '')
    if (!m) return null
    return m.slice(1).reduce((acc, o) => acc * 256 + Number(o), 0)
  }

  /** Rank by how much attention the client needs, not alphabetically. */
  const statusKey = (d: Device): number =>
    blockedMacs.has((d.mac ?? '').toLowerCase()) ? 0
      : d.paused ? 1
      : (Boolean(d.connected) && !d.ip) ? 2
      : d.connected ? 3 : 4

  /* Associated but holding no IPv4 lease. eero reports the client connected,
     and it is — at layer 2, with a signal and a link rate — but it has no
     address, so nothing above the link works. Calling it offline would
     contradict eero and collapse two different states into one word; leaving
     it green would call a broken client healthy. */
  const noLease = (d: Device) => Boolean(d.connected) && !d.ip

  const state = (d: Device): State => {
    if (blockedMacs.has((d.mac ?? '').toLowerCase())) return 'bad'
    if (d.paused) return 'warn'
    if (noLease(d)) return 'warn'
    return d.connected ? 'ok' : 'idle'
  }
  const stateLabel = (d: Device) =>
    blockedMacs.has((d.mac ?? '').toLowerCase()) ? t('profile_filters.blocked')
      : d.paused ? t('profiles.paused')
      : noLease(d) ? t('clients.no_lease') : d.connected ? t('clients.online') : t('clients.offline')

  const cols: Column<Device>[] = [
    {
      key: 'name', header: t('clients.column_client'), stopsRowClick: false,
      sortValue: (d) =>
        (d.nickname || d.hostname || d.display_name || '').toLowerCase() || null,
      render: (d) => (
        <span className="flex items-center gap-2">
          <DeviceIcon type={d.device_type} size={18} />
          {d.nickname || d.hostname || d.display_name || (
            <span className="text-[var(--color-ink-3)]">{t('clients.unnamed_device')}</span>
          )}
        </span>
      ),
    },
    // Status is stated once, as a dot and its label together. Color alone
    // would not survive colorblindness or grayscale.
    { key: 'st', header: t('client_detail.status'), sortValue: statusKey,
      render: (d) => (
        <StatusDot state={state(d)} label={stateLabel(d)}
                   icon={d.paused ? 'pause' : undefined} />
      ) },
    { key: 'ip', header: t('clients.ip_address'), sortValue: (d) => ipKey(d.ip),
      render: (d) => (
        <span className="inline-flex items-baseline gap-1.5">
          {reservedMacs.has((d.mac ?? '').toLowerCase()) && (
            <span title={t('clients.reserved_address')} aria-label={t('clients.reserved_address')}
              className="rounded bg-[var(--color-accent-wash)] px-1 text-[10px]
                         font-semibold leading-[1.4] text-[var(--color-accent-ink)]">
              R
            </span>
          )}
          {/* The status column already names the no-lease case, so this one
              does not repeat it — it just does not invent an address. */}
          {d.ip
            ? <span className="font-mono text-[12px]">{d.ip}</span>
            : <span className="text-[12px] text-[var(--color-ink-3)]"
                    title={noLease(d)
                      ? t('clients.no_ipv4_lease_any_ipv6') : t('clients.no_address_recorded')}>
                {t('clients.text')}
              </span>}
        </span>
      ) },
    // Which band a client landed on is the thing people actually want from
    // this column: eero reports the channel in MHz, so it is named here.
    { key: 'conn', header: t('client_detail.connection'), secondary: true,
      sortValue: connLabel,
      render: (d) => connLabel(d) ?? '—' },
    { key: 'node', header: t('clients.connected'), secondary: true,
      sortValue: (d) => d.source?.location ?? null,
      render: (d) => d.source?.location ?? '—' },
    // Sorted on the numeric dBm, so wired clients (no reading) sink to the
    // bottom rather than being treated as the weakest signal.
    /* Sorted by the bars it draws, not by the dBm behind them.
       This sorted on `rssi` while the cell drew `score_bars`, and those are
       different measurements: eero's score is its own quality judgment and
       is not a function of RSSI. On this network that put eight pairs out of
       order — a client at -76 dBm showing one bar above one at -78 showing
       four — so the column read 3, 2, 3, 2, 4 down the page.

       dBm breaks ties inside a band, so a run of four-bar clients is still
       strongest-first rather than in whatever order they arrived. Scaled
       rather than compared pairwise because a column sorts on one value:
       bars dominate, and the dBm term cannot reach the next band because a
       plausible RSSI range is nowhere near 100 wide. */
    { key: 'sig', header: t('client_detail.signal'), secondary: true,
      align: 'center', sortValue: (d) => signalSort(link(d)),
      render: (d) => {
        // A wired client has no signal to report, but it does have a
        // negotiated link speed, which is the equivalent thing worth knowing.
        if (d.connected && isWired(d)) {
          return <WiredLink />
        }
        /* `beside`: the dBm shows on hover without holding a blank to the
           right of the bars, which would put them left of center. */
        return <SignalBars value={clientBars(link(d))} dbm={rssi(d)} reading="beside" />
      } },
    { key: 'prof', header: t('client_detail.profile'), secondary: true,
      sortValue: (d) => d.profile?.name ?? null,
      render: (d) => d.profile?.name ?? '—' },
    /* Two columns, two switches. One "Actions" column of buttons whose captions
       flipped between Pause and Resume meant the column read differently on
       every row, and the caption was the only place the current state appeared.
       A switch puts the state in its position instead, so the column can be
       scanned down: every client that is paused shows the same thing. */
    {
      key: 'pause', header: t('clients.column_pause'), stopsRowClick: true,
      align: 'center', sortValue: (d) => (d.paused ? 0 : 1),
      render: (d) => {
        const isBlocked = blockedMacs.has((d.mac ?? '').toLowerCase())
        return (
          <Toggle
            checked={Boolean(d.paused)}
            disabled={busy === d.url || isBlocked}
            srLabel={t('clients.pause_for', { name: nameOf(d) })}
            onChange={() => pause(d)} />
        )
      },
    },
    {
      key: 'block', header: t('clients.column_block'), stopsRowClick: true,
      align: 'center',
      sortValue: (d) => (blockedMacs.has((d.mac ?? '').toLowerCase()) ? 0 : 1),
      render: (d) => (
        <Toggle
          checked={blockedMacs.has((d.mac ?? '').toLowerCase())}
          disabled={busy === d.url}
          srLabel={t('clients.block_for', { name: nameOf(d) })}
          onChange={() => block(d)} />
      ),
    },
  ]

  if (err) return <Notice kind="bad">{err}</Notice>

  const counts = {
    all: rows.length,
    online: rows.filter((d) => d.connected).length,
    offline: rows.filter((d) => !d.connected).length,
    paused: rows.filter((d) => d.paused).length,
    blocked: blocked.length,
  }

  return (
    <Page name="clients">
    <Card icon="clients"
      title={t('nav.clients')}
      count={loaded ? filtered.length : null}
        anchor="clients"
      action={
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder={t('clients.filter')} aria-label={t('clients.filter_clients')}
          className="w-40 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1 text-[13px]" />
      }
    >
      <div className="mb-3 flex flex-wrap gap-1.5">
        {(['all', 'online', 'offline', 'paused', 'blocked'] as Filter[]).map((f) => (
          <button key={f} type="button" onClick={() => setFilter(f)} aria-pressed={filter === f}
            className={`rounded-md border px-2.5 py-1 text-[12px] capitalize ${
              filter === f
                ? 'border-[var(--color-accent)] bg-[var(--color-accent-wash)] text-[var(--color-accent-ink)]'
                : 'border-[var(--color-line-strong)] text-[var(--color-ink-2)]'}`}>
            {t(`clients.filter_${f}`)}{' '}
            {/* Blank until the clients are in. Every one of these read 0
                during the load and then jumped to its real figure, which is
                five numbers changing under somebody choosing between them. */}
            {/* Quieter than the word beside it, but not by so much that it
                stops being readable: at 60% of the chip's own ink this came
                out at 2.9:1 on white in every theme, which is a number
                somebody is meant to compare against four others. */}
            <span className={`tabular-nums transition-opacity duration-200 ${
              loaded ? 'opacity-80' : 'opacity-0'}`}>
              {loaded ? counts[f] : '\u00a0\u00a0'}
            </span>
          </button>
        ))}
      </div>

      {say.node}

      <DataTable loading={!loaded} columns={cols} rows={filtered} rowKey={(d) => d.url} empty={t('clients.no_clients_match_filter_offline')}
                 onRowClick={(d) => setSelectedMac(d.mac ?? null)}
            /* A long client list is unreadable as stacked cards, so on narrow
               screens each device is one line: what it is, and whether it is
               on. Everything else lives in the panel a tap away. */
            mobileRow={(d) => (
              <>
                {/* The same indicator the wide table uses. This renderer is
                    a separate branch, so a change to the desktop column does
                    not reach it — which is how the pause glyph shipped on one
                    and not the other. */}
                <StatusDot state={state(d)}
                           icon={d.paused ? 'pause' : undefined} />
                <DeviceIcon type={d.device_type} size={18} />
                <span className="min-w-0 flex-1 truncate text-[13px]">
                  {d.nickname || d.hostname || d.display_name || d.mac}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-[var(--color-ink-3)]">
                  {d.ip ?? ''}
                </span>
              </>
            )}
                 defaultSort={{ key: 'st' }} />

      <Drawer
        open={Boolean(selected)}
        onClose={() => setSelectedMac(null)}
        /* Editable in the header as well as in Identity below. The name at the
           top of the panel is the one you are looking at when you decide it is
           wrong, so that is where it can be changed; both write the same
           field. */
        title={selected ? (
          <EditableText
            value={selected.nickname || selected.hostname
                   || selected.display_name || ''}
            placeholder={t('clients.unnamed_device')}
            onSave={async (v: string) => {
              await api.put(`/api/devices/${selected.mac}`, { nickname: v })
              load()
              // Remount the detail panel: it holds its own copy of the client
              // and would otherwise keep showing the old name below.
              setDetailKey((n) => n + 1)
            }}
          />
        ) : t('clients.client')}
      >
        {selected?.mac && (
          <ClientDetail key={detailKey} mac={selected.mac} onChanged={load} />
        )}
      </Drawer>
    </Card>
    </Page>
  )
}
