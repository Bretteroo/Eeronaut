import { DeviceTree } from '../components/DeviceTree'
import { Page } from '../components/primitives'

/* What is connected to what.

   One card: the tree, from the internet down through the eeros to every
   client on them. Everything else that used to be here has gone somewhere it
   belongs better. The radio tables are on Airtime, drawn rather than
   tabulated, beside the airtime history they were always about. The eero
   table is on the Dashboard, which is where somebody looks first for the
   state of the hardware.

   What is left is the one question this page's name asks. */
export function Topology() {
  return (
    <Page name="topology">
      <DeviceTree />
    </Page>
  )
}
