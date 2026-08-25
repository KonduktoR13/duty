import { beforeEach, describe, expect, it, vi } from 'vitest'
import { calendarSyncId, syncForAccount } from '../src/calendar-sync'
import { resolveGoogleAccountProfile, resolveGoogleEmailProfile } from '../src/google-account'
import { clearGoogleAccessToken, getGoogleAccountEmail, GOOGLE_EMAIL_SCOPE, GOOGLE_SCOPE, requestGoogleToken, setGoogleLoginHint } from '../src/google-calendar'
import type { CalendarMonthSync } from '../src/types'

type Prompt = '' | 'select_account'

function installGoogleMock(prompts: Prompt[], configPrompts: Prompt[], loginHints: Array<string | undefined> = []) {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      google: {
        accounts: {
          oauth2: {
            initTokenClient: (config: { prompt?: Prompt; login_hint?: string; callback(response: { access_token: string; expires_in: number }): void }) => {
              configPrompts.push(config.prompt || '')
              loginHints.push(config.login_hint)
              return {
                requestAccessToken: (options?: { prompt?: Prompt; login_hint?: string }) => {
                  prompts.push(options?.prompt || '')
                  loginHints.push(options?.login_hint)
                  config.callback({ access_token: `token-${prompts.length}`, expires_in: 3600 })
                },
              }
            },
            revoke: (_token: string, done: () => void) => done(),
          },
        },
      },
    },
  })
}

beforeEach(() => {
  clearGoogleAccessToken()
  setGoogleLoginHint(undefined)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Google OAuth account UX', () => {
  it('uses prompt empty and the saved email after both restart and refresh', async () => {
    const prompts: Prompt[] = []
    const configPrompts: Prompt[] = []
    const loginHints: Array<string | undefined> = []
    installGoogleMock(prompts, configPrompts, loginHints)
    setGoogleLoginHint('budilnik53@gmail.com')
    await requestGoogleToken('')
    // Closing/reopening the PWA or refreshing discards the in-memory token,
    // while the locally restored email remains the default login hint.
    clearGoogleAccessToken()
    await requestGoogleToken('')
    expect(configPrompts).toEqual(['', ''])
    expect(prompts).toEqual(['', ''])
    expect(loginHints).toEqual([
      'budilnik53@gmail.com', 'budilnik53@gmail.com',
      'budilnik53@gmail.com', 'budilnik53@gmail.com',
    ])
  })

  it('uses select_account only for an explicit account switch', async () => {
    const prompts: Prompt[] = []
    const configPrompts: Prompt[] = []
    const loginHints: Array<string | undefined> = []
    installGoogleMock(prompts, configPrompts, loginHints)
    setGoogleLoginHint('old@gmail.com')
    await requestGoogleToken('')
    await requestGoogleToken('select_account')
    expect(prompts).toEqual(['', 'select_account'])
    expect(configPrompts).toEqual(['', 'select_account'])
    expect(loginHints.slice(-2)).toEqual([undefined, undefined])
  })

  it('requests only the minimal email scope and reads the selected account email', async () => {
    installGoogleMock([], [])
    expect(GOOGLE_SCOPE.split(' ')).toContain(GOOGLE_EMAIL_SCOPE)
    await requestGoogleToken('')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ email: 'budilnik53@gmail.com', verified_email: true }), { status: 200 })))
    expect(await getGoogleAccountEmail()).toBe('budilnik53@gmail.com')
  })

  it('keeps sync state for two Google accounts isolated', () => {
    const base = { month: '2026-08', deltaNumber: 'D12', syncedAt: 1, events: {} }
    const accountA: CalendarMonthSync = { ...base, id: calendarSyncId(base.month, base.deltaNumber, 'account-a'), accountProfileId: 'account-a' }
    const accountB: CalendarMonthSync = { ...base, id: calendarSyncId(base.month, base.deltaNumber, 'account-b'), accountProfileId: 'account-b' }
    const records = [accountA, accountB]
    expect(syncForAccount(records, base.month, base.deltaNumber, 'account-a')).toBe(accountA)
    expect(syncForAccount(records, base.month, base.deltaNumber, 'account-b')).toBe(accountB)
    expect(resolveGoogleAccountProfile('account-a', true, { profileIds: ['account-b'], eventIds: [] }, records)).toBe('account-b')
    expect(resolveGoogleAccountProfile('account-a', true, { profileIds: [], eventIds: [] }, records)).toBeUndefined()
    const settings = { enabled: true, accountEmail: 'a@gmail.com', accountProfileId: 'account-a', accountProfiles: { 'a@gmail.com': 'account-a', 'b@gmail.com': 'account-b' } }
    expect(resolveGoogleEmailProfile('b@gmail.com', settings, true, { profileIds: [], eventIds: [] }, records)).toBe('account-b')
  })
})
