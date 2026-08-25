import type { CalendarEventDraft } from './types'
import { CALENDAR_MARKER, type CalendarGateway, type RemoteCalendarEvent } from './calendar-sync'

export const GOOGLE_CLIENT_ID = '985972419123-valpboh05jcstqn7h68qj2d0kql0lfes.apps.googleusercontent.com'
export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events.owned'
export const GOOGLE_EMAIL_SCOPE = 'https://www.googleapis.com/auth/userinfo.email'
export const GOOGLE_SCOPE = `${GOOGLE_CALENDAR_SCOPE} ${GOOGLE_EMAIL_SCOPE}`

type TokenResponse = { access_token?: string; expires_in?: number; error?: string; error_description?: string }
type TokenClient = { requestAccessToken(options?: { prompt?: string; login_hint?: string }): void }
export type GoogleTokenPrompt = '' | 'select_account'

declare global {
  interface Window {
    google?: { accounts: { oauth2: { initTokenClient(config: { client_id: string; scope: string; prompt?: GoogleTokenPrompt; login_hint?: string; include_granted_scopes: boolean; callback(response: TokenResponse): void; error_callback?(error: unknown): void }): TokenClient; revoke(token: string, done: () => void): void } } }
  }
}

export class GoogleAuthError extends Error {}
export class GoogleApiError extends Error {
  constructor(message: string, public status: number) { super(message) }
}

let scriptPromise: Promise<void> | undefined
let access: { token: string; expiresAt: number } | undefined
let defaultLoginHint: string | undefined

export function prepareGoogleIdentityServices() {
  if (window.google?.accounts.oauth2) return Promise.resolve()
  if (scriptPromise) return scriptPromise
  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () => reject(new GoogleAuthError('Не удалось загрузить Google Identity Services'))
    document.head.append(script)
  })
  return scriptPromise
}

export function hasLiveGoogleToken() {
  return Boolean(access && access.expiresAt > Date.now())
}

export function setGoogleLoginHint(email?: string) {
  defaultLoginHint = email
}

export async function requestGoogleToken(prompt: GoogleTokenPrompt = '', loginHint = defaultLoginHint): Promise<string> {
  if (prompt === 'select_account') access = undefined
  if (access && access.expiresAt > Date.now()) return access.token
  await prepareGoogleIdentityServices()
  return new Promise<string>((resolve, reject) => {
    const client = window.google!.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: GOOGLE_SCOPE,
      prompt,
      ...(prompt === '' && loginHint ? { login_hint: loginHint } : {}),
      include_granted_scopes: true,
      callback: response => {
        if (!response.access_token || response.error) {
          reject(new GoogleAuthError(response.error_description || response.error || 'Google не выдал доступ'))
          return
        }
        access = { token: response.access_token, expiresAt: Date.now() + Math.max(60, response.expires_in || 3600) * 1000 - 60_000 }
        resolve(access.token)
      },
      error_callback: () => reject(new GoogleAuthError('Авторизация Google была закрыта или заблокирована')),
    })
    client.requestAccessToken({ prompt, ...(prompt === '' && loginHint ? { login_hint: loginHint } : {}) })
  })
}

export async function getGoogleAccountEmail() {
  const token = await requestGoogleToken('', defaultLoginHint)
  let response: Response
  try {
    response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: `Bearer ${token}` } })
  } catch {
    throw new TypeError('offline')
  }
  if (response.status === 401) {
    access = undefined
    throw new GoogleAuthError('Google требует повторную авторизацию')
  }
  if (!response.ok) throw new GoogleApiError(`Google UserInfo API: ${response.status}`, response.status)
  const result = await response.json() as { email?: string; verified_email?: boolean }
  if (!result.email) throw new GoogleAuthError('Google не вернул email выбранного аккаунта')
  return result.email
}

export function clearGoogleAccessToken() {
  access = undefined
}

export async function revokeGoogleAccess() {
  const token = access?.token
  access = undefined
  if (!token || !window.google?.accounts.oauth2) return
  await new Promise<void>(resolve => window.google!.accounts.oauth2.revoke(token, resolve))
}

async function api(path: string, init: RequestInit = {}, allowMissing = false) {
  const token = await requestGoogleToken('')
  let response: Response
  try {
    response = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    })
  } catch {
    throw new TypeError('offline')
  }
  if (allowMissing && (response.status === 404 || response.status === 410)) return null
  if (response.status === 401) {
    access = undefined
    throw new GoogleAuthError('Google требует повторную авторизацию')
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: { message?: string } }
    throw new GoogleApiError(body.error?.message || `Google Calendar API: ${response.status}`, response.status)
  }
  return response.status === 204 ? null : response.json()
}

export type DutyAccountDiscovery = { profileIds: string[]; eventIds: string[] }

export async function discoverDutyAccounts(): Promise<DutyAccountDiscovery> {
  const profileIds = new Set<string>()
  const eventIds: string[] = []
  let pageToken = ''
  do {
    const query = new URLSearchParams({ privateExtendedProperty: `dutyPwa=${CALENDAR_MARKER}`, maxResults: '2500', showDeleted: 'false' })
    if (pageToken) query.set('pageToken', pageToken)
    const result = await api(`/calendars/primary/events?${query}`) as { items?: RemoteCalendarEvent[]; nextPageToken?: string }
    for (const event of result.items || []) {
      if (event.id) eventIds.push(event.id)
      const profileId = event.extendedProperties?.private?.dutyAccount
      if (profileId) profileIds.add(profileId)
    }
    pageToken = result.nextPageToken || ''
  } while (pageToken)
  return { profileIds: [...profileIds], eventIds }
}

export function googleEventPayload(eventId: string | undefined, draft: CalendarEventDraft, properties: Record<string, string>) {
  return {
    ...(eventId ? { id: eventId } : {}),
    summary: draft.summary,
    description: draft.description,
    status: 'confirmed' as const,
    transparency: 'opaque' as const,
    start: draft.start,
    end: draft.end,
    extendedProperties: { private: properties },
  }
}

function body(eventId: string | undefined, draft: CalendarEventDraft, properties: Record<string, string>) {
  return JSON.stringify(googleEventPayload(eventId, draft, properties))
}

export function collisionGoogleEventId(eventId: string, attempt: number) {
  if (attempt === 0) return eventId
  const suffix = attempt.toString(16)
  return eventId.slice(0, 1024 - suffix.length) + suffix
}

function ownsEvent(event: RemoteCalendarEvent, properties: Record<string, string>) {
  return Object.entries(properties).every(([key, value]) => event.extendedProperties?.private?.[key] === value)
}

export const googleCalendarGateway: CalendarGateway = {
  get: async eventId => {
    const event = await api(`/calendars/primary/events/${encodeURIComponent(eventId)}`, {}, true) as RemoteCalendarEvent | null
    return event?.status === 'cancelled' ? null : event
  },
  insert: async (eventId, draft, properties) => {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidateId = collisionGoogleEventId(eventId, attempt)
      try {
        return await api('/calendars/primary/events', { method: 'POST', body: body(candidateId, draft, properties) }) as RemoteCalendarEvent
      } catch (error) {
        if (!(error instanceof GoogleApiError) || error.status !== 409) throw error
        const existing = await api(`/calendars/primary/events/${encodeURIComponent(candidateId)}`, {}, true) as RemoteCalendarEvent | null
        // Google keeps deleted event IDs as cancelled tombstones. Reusing such an ID
        // can return success while the event remains invisible, so use the next ID.
        if (!existing || existing.status === 'cancelled') continue
        if (!ownsEvent(existing, properties)) throw error
        return await api(`/calendars/primary/events/${encodeURIComponent(candidateId)}`, { method: 'PATCH', headers: existing.etag ? { 'If-Match': existing.etag } : {}, body: body(undefined, draft, properties) }) as RemoteCalendarEvent
      }
    }
    throw new GoogleApiError('Google Calendar не освободил идентификатор удалённого события', 409)
  },
  patch: (eventId, draft, properties, etag) => api(`/calendars/primary/events/${encodeURIComponent(eventId)}`, { method: 'PATCH', headers: etag ? { 'If-Match': etag } : {}, body: body(undefined, draft, properties) }) as Promise<RemoteCalendarEvent>,
  remove: (eventId, etag) => api(`/calendars/primary/events/${encodeURIComponent(eventId)}`, { method: 'DELETE', headers: etag ? { 'If-Match': etag } : {} }, true).then(() => undefined),
}

export async function deterministicGoogleEventId(installationId: string, syncId: string, key: string, recovery = false) {
  const value = new TextEncoder().encode(`${installationId}|${syncId}|${key}|${recovery ? 'recovery' : 'main'}`)
  const digest = await crypto.subtle.digest('SHA-256', value)
  return 'd17a' + [...new Uint8Array(digest)].slice(0, 20).map(byte => byte.toString(16).padStart(2, '0')).join('')
}
