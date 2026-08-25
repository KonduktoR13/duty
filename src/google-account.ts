import type { CalendarMonthSync } from './types'
import type { DutyAccountDiscovery } from './google-calendar'

export function createGoogleAccountProfileId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return 'ga-' + [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export function resolveGoogleAccountProfile(
  currentProfileId: string | undefined,
  explicitSwitch: boolean,
  discovery: DutyAccountDiscovery,
  syncs: CalendarMonthSync[],
) {
  const knownProfiles = new Set(syncs.map(sync => sync.accountProfileId).filter((value): value is string => Boolean(value)))
  if (currentProfileId) knownProfiles.add(currentProfileId)
  const candidates = new Set(discovery.profileIds.filter(profileId => knownProfiles.has(profileId)))
  const remoteIds = new Set(discovery.eventIds)
  for (const sync of syncs) {
    if (sync.accountProfileId && Object.values(sync.events).some(event => remoteIds.has(event.eventId))) candidates.add(sync.accountProfileId)
  }
  if (currentProfileId && candidates.has(currentProfileId)) return currentProfileId
  if (candidates.size === 1) return [...candidates][0]
  // With ordinary prompt:'' an empty calendar can also mean that all managed
  // events were manually deleted. Keep the current profile so they can be
  // detected and restored. An explicit account switch instead starts an
  // isolated profile when this Calendar account has no recognizable events.
  return explicitSwitch ? undefined : currentProfileId
}
