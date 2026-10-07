/**
 * What this app can do, as a searchable list.
 *
 * The search box indexed clients and eeros, which answers "where is that
 * device" but not "where do I change that setting" — and the second question
 * is the one a nine-tab interface actually raises. Typing "DHCP" should land
 * on the pane that owns DHCP, not return nothing.
 *
 * Each entry names the pane it belongs to rather than only the page, because
 * "somewhere on the Network tab" is not an answer on a tab with nine panes.
 * The `pane` value is matched against a `Card`'s `anchor`, which scrolls it
 * into view and flashes it on arrival.
 *
 * `keywords` are what someone types instead of the title: eero's own name for
 * a thing, the acronym, the protocol, the wrong-but-common word. They are
 * matched on prefix, so "reserv" finds "reservation".
 */
import { t } from '../i18n'

export interface Feature {
  /** Catalog key for the pane's name, translated where it is shown.
   *  A key rather than the text: this array is module-level, so anything
   *  evaluated here would freeze in whatever language happened to be in force
   *  at import — which is none of them. */
  title: string
  /** Catalog key for where it lives, for the reader. */
  where: string
  path: string
  /** The `anchor` of the Card to scroll to, when the page has one. */
  pane?: string
  keywords: string[]
}

export const FEATURES: Feature[] = [
  /* ------------------------------------------------------------- network */
  {
    title: 'feature.internet_connection', where: 'feature.where_internet', path: '/internet', pane: 'internet',
    keywords: ['dhcp', 'static ip', 'pppoe', 'wan', 'isp', 'provider', 'uplink',
               'vlan', 'vlan tag', 'public address', 'gateway', 'double nat',
               'ipv6', 'ipv6 upstream', 'dynamic dns', 'ddns', 'hostname'],
  },
  {
    title: 'feature.lan_addressing', where: 'feature.where_network', path: '/network', pane: 'lan',
    keywords: ['lan', 'subnet', 'address range', 'dhcp pool', 'manual ip',
               'bridge', 'bridge mode', 'nat', 'port randomization', 'upnp'],
  },
  {
    title: 'feature.dns_servers', where: 'feature.where_internet', path: '/internet', pane: 'dns',
    keywords: ['dns', 'custom dns', 'isp dns', 'resolver', 'name server',
               'cloudflare', 'quad9', '1.1.1.1'],
  },
  {
    title: 'feature.wi_fi', where: 'feature.where_network', path: '/network', pane: 'wifi',
    keywords: ['wifi', 'wi-fi', 'ssid', 'network name', 'password', 'passphrase',
               'wpa3', 'wpa2', 'security', 'band steering', 'smart queue',
               'sqm', 'mlo', 'multi-link', 'rename'],
  },
  {
    title: 'feature.guest_network', where: 'feature.where_network', path: '/network', pane: 'guest',
    keywords: ['guest', 'guest wifi', 'visitor', 'guest password'],
  },
  {
    title: 'feature.thread', where: 'feature.where_network', path: '/network', pane: 'thread',
    keywords: ['thread', 'matter', 'border router', 'joining credentials',
               'network key', 'keychain', 'pan id', 'smart home'],
  },
  {
    title: 'feature.power_saving', where: 'feature.where_network', path: '/network', pane: 'power',
    keywords: ['power', 'power saving', 'idle', 'schedule', 'overnight',
               'energy'],
  },
  {
    title: 'feature.troubleshooting', where: 'feature.where_network', path: '/network', pane: 'troubleshooting',
    keywords: ['troubleshoot', 'legacy', '802.11b', '802.11a', '802.11g',
               'older devices', 'pause 5 ghz', 'pause 6 ghz', '2.4 ghz',
               'will not connect', 'cannot connect'],
  },
  {
    title: 'feature.dhcp_reservations', where: 'feature.where_network', path: '/network', pane: 'reservations',
    keywords: ['reservation', 'reserve', 'static lease', 'fixed ip',
               'pin an address', 'dhcp reservation'],
  },

  /* ------------------------------------------------------------ security */
  {
    title: 'feature.network_wide_protection', where: 'feature.where_security', path: '/security', pane: 'protection',
    keywords: ['ad block', 'adblock', 'ads', 'advanced security', 'malware',
               'phishing', 'threat', 'block ads'],
  },
  {
    title: 'feature.inbound_access', where: 'feature.where_security', path: '/security', pane: 'inbound',
    keywords: ['port forward', 'forwarding', 'pinhole', 'ipv6 pinhole',
               'firewall', 'open port', 'nat', 'expose', 'inbound'],
  },
  {
    title: 'feature.domain_rules', where: 'feature.where_security', path: '/security', pane: 'domains',
    keywords: ['block site', 'allow site', 'blocklist', 'allowlist',
               'blocked domains', 'allowed domains', 'website'],
  },

  /* ------------------------------------------------------------ profiles */
  {
    title: 'feature.profiles', where: 'feature.where_profiles', path: '/profiles', pane: 'profiles',
    keywords: ['profile', 'family', 'kids', 'group', 'pause', 'pause internet',
               'content filter', 'blocked apps', 'scheduled pause', 'bedtime',
               'ad blocking per profile', 'blocked sites', 'allowed sites',
               'safe search', 'youtube restricted'],
  },

  /* ------------------------------------------------------------- clients */
  {
    title: 'feature.clients', where: 'feature.where_clients', path: '/clients', pane: 'clients',
    keywords: ['client', 'device', 'connected', 'block device', 'rename device',
               'device type', 'signal', 'mac address'],
  },

  /* ------------------------------------------------------------ topology */
  {
    title: 'feature.network_map', where: 'feature.where_topology', path: '/topology', pane: 'map',
    keywords: ['topology', 'tree', 'map', 'what is connected to what',
               'which eero', 'plugged into'],
  },
  {
    /* The mesh diagram is on the Dashboard — a picture of how the network is
       put together is the first thing worth seeing, so it moved there and
       this entry moved with it. */
    title: 'feature.mesh_layout', where: 'feature.where_dashboard', path: '/', pane: 'mesh',
    keywords: ['mesh', 'backhaul', 'uplink', 'diagram', 'wired or wireless',
               'which eero', 'node'],
  },
  {
    /* On Airtime since the radio tables left Topology: the channels are drawn
       there now, beside the airtime history they belong with. */
    title: 'feature.radio_channels', where: 'feature.where_airtime', path: '/airtime', pane: 'channels',
    keywords: ['radio', 'channel', 'width', 'frequency', 'overlap',
               'same channel', 'overlapping', 'airtime per radio'],
  },

  /* ------------------------------------------------------------- airtime */
  {
    title: 'feature.airtime_and_interference', where: 'feature.where_airtime', path: '/airtime', pane: 'airtime',
    keywords: ['airtime', 'utilization', 'congestion', 'interference',
               'channel usage', 'radio analytics', 'noise'],
  },

  /* ------------------------------------------------------------ insights */
  {
    title: 'feature.speed_test_history', where: 'feature.where_insights', path: '/insights', pane: 'speedtests',
    keywords: ['speed test', 'speedtest', 'bandwidth', 'mbps', 'download speed',
               'upload speed', 'how fast'],
  },
  {
    title: 'feature.data_transferred', where: 'feature.where_insights', path: '/insights', pane: 'transferred',
    keywords: ['data usage', 'usage', 'transferred', 'bandwidth used',
               'how much data', 'gigabytes'],
  },
  {
    title: 'feature.heaviest_clients', where: 'feature.where_insights', path: '/insights', pane: 'heaviest',
    keywords: ['heaviest', 'top clients', 'who is using', 'biggest downloader',
               'biggest uploader', 'hogging'],
  },

  /* ------------------------------------------------------- the connection */
  {
    title: 'feature.internet_connection_status', where: 'feature.where_internet', path: '/internet', pane: 'wan',
    keywords: ['offline', 'no internet', 'internet is down', 'outage', 'wan',
               'modem', 'cable modem', 'no link', 'dropped', 'disconnected',
               'why is my internet down', 'troubleshoot internet', 'isp',
               'down for', 'diagnose'],
  },
  {
    /* The eeros themselves, and what can be done to one: the dashboard's list
       opens a drawer per node. The Local control page these used to live on is
       gone, and with it the site survey, so nothing here promises one. */
    title: 'feature.eeros', where: 'feature.where_dashboard', path: '/',
    keywords: ['eero', 'eeros', 'node', 'reboot', 'restart eero', 'identify',
               'status light', 'led', 'nightlight', 'remove eero', 'uptime',
               'firmware version'],
  },
  {
    title: 'feature.internet_backup', where: 'feature.where_internet', path: '/internet', pane: 'backup',
    keywords: ['internet backup', 'backup internet', 'hotspot backup',
               'hotspot', 'cellular backup', 'eero signal', 'signal',
               'failover', 'outage', 'backup network', '5g', 'lte', 'redcap',
               'stay online'],
  },

  /* ------------------------------------------------------------ settings */
  {
    title: 'feature.notifications', where: 'feature.where_settings', path: '/settings', pane: 'notifications',
    keywords: ['notification', 'alert', 'email', 'usage report', 'push'],
  },
  {
    title: 'feature.display_and_appearance', where: 'feature.where_settings', path: '/settings', pane: 'display',
    keywords: ['theme', 'dark mode', 'light mode', 'appearance', 'compact'],
  },
  /* The clock and the language are cards of their own now, so searching for
     either lands on the card rather than on the one above it. The titles are
     the cards' own — one name for one thing. */
  {
    title: 'settings.date_and_time', where: 'feature.where_settings', path: '/settings', pane: 'time',
    keywords: ['clock', '24 hour', '12 hour', 'time format', 'time zone',
               'timezone', 'date'],
  },
  {
    title: 'settings.language', where: 'feature.where_settings', path: '/settings', pane: 'language',
    keywords: ['language', 'translation', 'locale', 'english', 'spanish',
               'french', 'hungarian'],
  },
  {
    title: 'feature.feature_filters', where: 'feature.where_settings', path: '/settings', pane: 'filters',
    keywords: ['eero plus', 'subscription', 'hide features', 'plus badges',
               'unavailable'],
  },
  {
    title: 'feature.firmware_and_updates', where: 'feature.where_settings', path: '/settings', pane: 'firmware',
    keywords: ['firmware', 'update', 'version', 'update window', 'upgrade'],
  },
  {
    title: 'feature.interface_access', where: 'feature.where_settings', path: '/settings', pane: 'access',
    keywords: ['password', 'change password', 'sign out', 'log out',
               'interface password', 'session'],
  },
]

/**
 * Features matching a query, best first.
 *
 * Scored rather than filtered, so "dns" puts the DNS pane above the Internet
 * pane that merely mentions dynamic DNS. A title match outranks a keyword
 * match, and a keyword that starts with the query outranks one that merely
 * contains it — typing "res" should reach reservations before it reaches
 * anything whose description happens to contain the letters.
 */
export function searchFeatures(query: string, limit = 6): Feature[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const scored: { f: Feature; score: number }[] = []
  for (const f of FEATURES) {
    /* The name as it is read, not the catalog key it is stored under.
       Scoring `f.title` matched 'feature.dns_servers' against what somebody
       types, so "DNS servers", the words printed on the pane, found nothing;
       every hit the search returned came from a keyword instead. */
    const title = t(f.title).toLowerCase()
    let score = 0
    if (title === q) score = 100
    else if (title.startsWith(q)) score = 80
    else if (title.includes(q)) score = 60
    for (const k of f.keywords) {
      if (k === q) score = Math.max(score, 90)
      else if (k.startsWith(q)) score = Math.max(score, 70)
      else if (k.includes(q)) score = Math.max(score, 40)
    }
    if (score) scored.push({ f, score })
  }
  return scored
    .sort((a, b) => b.score - a.score || a.f.title.localeCompare(b.f.title))
    .slice(0, limit)
    .map((x) => x.f)
}
