import { beforeEach, describe, expect, it } from 'vitest'
import { calendarSyncId, syncForAccount } from '../src/calendar-sync'
import { resolveGoogleAccountProfile } from '../src/google-account'
import { clearGoogleAccessToken, requestGoogleToken } from '../src/google-calendar'
import type { CalendarMonthSync } from '../src/types'

type Prompt = '' | 'select_account'

function installGoogleMock(prompts: Prompt[], configPrompts: Prompt[]) {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      google: {
        accounts: {
          oauth2: {
            initTokenClient: (config: { prompt?: Prompt; callback(response: { access_token: string; expires_in: number }): void }) => {
              configPrompts.push(config.prompt || '')
              return {
                requestAccessToken: (options?: { prompt?: Prompt }) => {
                  prompts.push(options?.prompt || '')
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

beforeEach(() => clearGoogleAccessToken())

describe('Google OAuth account UX', () => {
  it('requests a new session token with an explicit empty prompt', async () => {
    const prompts: Prompt[] = []
    const configPrompts: Prompt[] = []
    installGoogleMock(prompts, configPrompts)
    await requestGoogleToken('')
    clearGoogleAccessToken()
    await requestGoogleToken('')
    expect(configPrompts).toEqual(['', ''])
    expect(prompts).toEqual(['', ''])
  })

  it('uses select_account only for an explicit account switch', async () => {
    const prompts: Prompt[] = []
    const configPrompts: Prompt[] = []
    installGoogleMock(prompts, configPrompts)
    await requestGoogleToken('')
    await requestGoogleToken('select_account')
    expect(prompts).toEqual(['', 'select_account'])
    expect(configPrompts).toEqual(['', 'select_account'])
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
  })
})
