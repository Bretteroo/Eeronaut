/**
 * How often each screen asks again, and where each number comes from.
 *
 * Every rate here is eero's own, read out of the decompiled Android client so
 * that this app asks no more of eero's service than eero's own app does. The
 * constant each one came from is named beside it; if one looks wrong, that is
 * the thing to go and check rather than a number somebody picked.
 *
 * The exception is `EERO_STATUS_BUSY_MS` in lib/nodeState, which is faster
 * than anything eero does and is documented there.
 *
 * A note on what these cost. Only some of these reach eero: the clients list,
 * the accessory detail and the network list are cloud reads. WAN diagnosis is
 * the local gRPC plane and never leaves the house. The backend also caches
 * reads for five seconds, so nothing here resolves finer than that however
 * often it is asked.
 */

/** `ProxiedNodesViewModelKt.REFRESH_INTERVAL_SECONDS = 3`.
 *
 *  The fastest rate in eero's app outside setup and burst reporting, and it
 *  is for exactly this: an accessory whose signal and registration state move
 *  on their own while somebody watches. Scoped to an open drawer, so it stops
 *  when the drawer closes rather than running for the session. */
export const ACCESSORY_MS = 3_000

/** `NetworkRepositoryKt.LOAD_DEVICES_POLL_DURATION_SECONDS = 10`. */
export const CLIENTS_MS = 10_000

/** `ManageNetworksViewModelKt.REFRESH_INTERVAL_SECONDS = 30`.
 *
 *  The list of networks on the account, which changes when somebody adds or
 *  is invited to one — rare, so thirty seconds. */
export const NETWORKS_MS = 30_000

/** `EcoEfficiencyRepositoryKt.REFRESH_INTERVAL_SECONDS = 30`.
 *
 *  "Eco efficiency" is eero's marketing name for power saving: that
 *  repository holds `_powerSavingStatus` and `_schedules` and calls
 *  `createPowerSavingSchedule`. Same feature as the Power card here, so it
 *  takes the same rate. I had it down as something we do not have, which was
 *  wrong — the names differ, not the feature. */
export const POWER_SAVING_MS = 30_000

/** `WanTroubleshootingViewModelKt.LOCAL_SESSION_UPDATE_INTERVAL = 5`.
 *
 *  Chosen over `WanTroubleshootingServiceKt.POLLING_INTERVAL = 2` because our
 *  diagnosis is one read of the local session per tick — `/api/local/
 *  network-status`, straight to the gateway — which is what that constant
 *  paces in eero's app. The 2 is its service loop, a different shape.
 *
 *  Either way this is the local plane, so the rate costs eero's service
 *  nothing. It was ten seconds here, which is slower than eero on the one
 *  screen somebody stares at during an outage. */
export const WAN_DIAGNOSIS_MS = 5_000

/** The client drawer's live receiving/sending meters, and only while one is
 *  open. Five seconds because that is eero's own:
 *  `LiveDataUsageService.DEFAULT_REPEAT_INTERVAL` in the Android app is
 *  `5.seconds`, and its live-usage screen polls the same device list at it. */
export const LIVE_RATE_MS = 5_000
