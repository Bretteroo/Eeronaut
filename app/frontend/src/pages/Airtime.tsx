import { ClientsByBand } from '../components/ClientsByBand'
import { RadioChannels } from '../components/RadioChannels'
import { RadioAnalytics } from '../components/RadioAnalytics'
import { Page } from '../components/primitives'

/* Radio behavior, on its own page.

   It reads a window of per-radio history out of eero's cloud, which is the
   slowest call the interface makes. That used to sit on Topology, where it
   held up a page whose real job — what is connected to what — needs none of
   that data. Separating them means Topology paints immediately and this page
   is opened only when somebody wants the detail.

   Three cards, in the order somebody arrives at the question. Where the
   wireless clients are, by band and by eero, built only from facts eero's own
   app shows a non-subscriber about each device. Then where this network's own
   radios sit on the air, which is where two eeros landing on the same
   channel becomes visible. Then the per-radio airtime history.

   The middle one was a site survey first, and could not stay one: a running
   eero reports a neighbor's name and signal and nothing else — no channel,
   no width — so there was nothing to place on an axis. What it draws instead
   is the network's own radios, which eero does report in full.

   There was once a different second card — a sparkline and a now/avg/peak
   reading per radio — that drew the same figures as the history charts from
   the same feed, without eero Plus and without asking whether the network had
   it. That was the one place in the app that handed out a paid feature's data
   to a network that has not paid for it, and it is why the rule for this page
   is what the app shows, not what the API returns. */
export function Airtime() {
  return (
    <Page name="airtime">
      <ClientsByBand />
      <RadioChannels />
      <RadioAnalytics />
    </Page>
  )
}
