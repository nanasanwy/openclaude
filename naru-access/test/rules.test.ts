import { describe, expect, test } from 'bun:test'
import { bandTypeFromBarcode, groupTiming, overtimeBlocks, type GroupClock } from '../src/core/rules.ts'
import { DEFAULT_SETTINGS, mergeSettings } from '../src/core/settings.ts'
import { dayType, localParts, localToMs, MINUTE } from '../src/core/time.ts'
import { at, setup, walkIn } from './helpers.ts'

describe('overtime blocks (brief example: play ends 3:00)', () => {
  const end = at('15:00')
  test.each([
    ['15:00', 0],
    ['15:01', 1],
    ['15:20', 1],
    ['15:30', 1],
    ['15:31', 2],
    ['15:40', 2],
    ['16:01', 3],
  ])('leaving at %s = %i block(s)', (time, blocks) => {
    expect(overtimeBlocks(at(time), end, 30)).toBe(blocks)
  })
})

describe('group timing', () => {
  const walkin: GroupClock = {
    type: 'walkin', status: 'active', firstScanAt: at('12:00'), playEndAt: at('15:00'),
    partyStartAt: null, extensionMinutes: 0, blocksPaid: 0, clearedAt: null,
  }
  test('phases through playing, grace and overtime', () => {
    expect(groupTiming(walkin, DEFAULT_SETTINGS, at('14:59')).phase).toBe('playing')
    expect(groupTiming(walkin, DEFAULT_SETTINGS, at('15:15')).phase).toBe('grace')
    const t = groupTiming(walkin, DEFAULT_SETTINGS, at('15:16'))
    expect(t).toMatchObject({ phase: 'overtime', exitLocked: true, blocksDue: 1, blocksOwed: 1 })
  })
  test('an extension moves the end and the grace period', () => {
    const t = groupTiming({ ...walkin, extensionMinutes: 30 }, DEFAULT_SETTINGS, at('15:40'))
    expect(t).toMatchObject({ phase: 'grace', exitLocked: false, effectiveEnd: at('15:30') })
  })
  test('after clearing, the exit stays open for the clear window, then locks for the next block', () => {
    const cleared = { ...walkin, blocksPaid: 1, clearedAt: at('15:25') }
    expect(groupTiming(cleared, DEFAULT_SETTINGS, at('15:29')).exitLocked).toBe(false)
    expect(groupTiming(cleared, DEFAULT_SETTINGS, at('15:34')).exitLocked).toBe(false) // within 10 min of clearing
    expect(groupTiming(cleared, DEFAULT_SETTINGS, at('15:36'))).toMatchObject({ exitLocked: true, blocksOwed: 1 })
  })
  test('a walk-in that has not scanned in has no timer', () => {
    expect(groupTiming({ ...walkin, firstScanAt: null, playEndAt: null }, DEFAULT_SETTINGS, at('20:00'))).toMatchObject({ phase: 'not_started', exitLocked: false })
  })
})

describe('band prefixes', () => {
  test('read adult, kid and under-2 rolls and reject anything else', () => {
    const p = DEFAULT_SETTINGS.bandPrefixes
    expect(bandTypeFromBarcode('a-000123', p)).toBe('adult')
    expect(bandTypeFromBarcode('K-000456', p)).toBe('kid')
    expect(bandTypeFromBarcode('U-000001', p)).toBe('under2')
    expect(bandTypeFromBarcode('X-000001', p)).toBeNull()
    expect(bandTypeFromBarcode('A-', p)).toBeNull()
  })
})

describe('settings', () => {
  test('partial updates merge and are validated', () => {
    const s = mergeSettings(DEFAULT_SETTINGS, { graceMinutes: 20, playPassPrice: { weekend: 55 } })
    expect(s.graceMinutes).toBe(20)
    expect(s.playPassPrice).toEqual({ weekday: 35, weekend: 55 })
    expect(() => mergeSettings(DEFAULT_SETTINGS, { capacity: -1 })).toThrow()
    expect(() => mergeSettings(DEFAULT_SETTINGS, { sessionMinutes: '180' })).toThrow(/number/)
    expect(() => mergeSettings(DEFAULT_SETTINGS, { bandPrefixes: { kid: 'A-' } })).toThrow(/overlap/)
    expect(() => mergeSettings(DEFAULT_SETTINGS, { nope: 1 })).toThrow(/Unknown setting/)
  })

  test('a manager change takes effect immediately and is audited; others cannot change settings', () => {
    const env = setup()
    expect(() => env.system.updateSettings(env.staff.supervisor, { graceMinutes: 0 })).toThrow(/not allowed/)
    env.system.updateSettings(env.staff.manager, { graceMinutes: 0 })
    const group = walkIn(env, ['A-000001'])
    env.time('12:00')
    env.system.scan('in', 'A-000001')
    env.time('15:01')
    expect(env.system.scan('out', 'A-000001').code).toBe('see_host')
    const audit = env.system.db.query<{ action: string; details: string }, []>(`SELECT action, details FROM audit_log WHERE action = 'settings.update'`).get()!
    expect(JSON.parse(audit.details)).toEqual({ graceMinutes: { from: 15, to: 0 } })
    expect(group.id).toBeGreaterThan(0)
  })
})

describe('audit trail', () => {
  test('scans, overrides and the audit log cannot be edited or deleted', () => {
    const env = setup()
    walkIn(env, ['A-000001'])
    env.system.scan('in', 'A-000001')
    env.system.manualOpen(env.staff.supervisor, 'in', 'Testing')
    env.system.createPackage(env.staff.cashier, { name: 'Test', phone: '0120000000', receiptNo: 'SH-1' })
    for (const sql of ['UPDATE scans SET result = \'refused\'', 'DELETE FROM scans', 'UPDATE overrides SET reason = \'x\'', 'DELETE FROM audit_log', 'DELETE FROM package_ledger']) {
      expect(() => env.system.db.exec(sql)).toThrow(/append-only/)
    }
  })

  test('the hash chain detects a tampered entry', () => {
    const env = setup()
    walkIn(env, ['A-000001'])
    expect(env.system.verifyAuditChain().ok).toBe(true)
    env.system.db.exec('DROP TRIGGER audit_log_no_update') // only possible with direct database access
    env.system.db.exec(`UPDATE audit_log SET details = '{"edited":true}' WHERE id = 2`)
    expect(env.system.verifyAuditChain()).toMatchObject({ ok: false, brokenAtId: 2 })
  })
})

describe('safety: nobody is trapped', () => {
  test('a band closed while its wearer is inside can still leave', () => {
    const env = setup()
    const g = walkIn(env, ['A-000001'])
    env.system.scan('in', 'A-000001')
    env.system.closeGroup(env.staff.supervisor, g.id, 'Wrong group')
    expect(env.system.scan('out', 'A-000001')).toMatchObject({ open: true, code: 'closed_exit' })
    expect(env.system.scan('in', 'A-000001').code).toBe('not_active')
  })

  test('end of day closes groups that are over but keeps future parties', () => {
    const env = setup(at('20:00'))
    walkIn(env, ['A-000001'])
    const tomorrow = env.system.createParty(env.staff.events, {
      name: 'Tomorrow', room: 'Private Room A', date: '2026-10-04', startTime: '14:00', expectedGuests: 10, hostName: 'H', hostPhone: '0120000000',
    })
    env.time('23:31')
    env.system.tick()
    expect(env.system.dashboard(env.staff.supervisor).groups.map(g => g.id)).toEqual([tomorrow.groupId])
    env.system.tick() // runs once per day
    expect(env.system.scan('in', 'A-000001').code).toBe('not_active')
  })
})

describe('time zone helpers', () => {
  test('Kuala Lumpur is UTC+8 and weekends/holidays are detected', () => {
    expect(new Date(localToMs('2026-10-03', '15:00', 'Asia/Kuala_Lumpur')).toISOString()).toBe('2026-10-03T07:00:00.000Z')
    expect(localParts(at('15:00'), 'Asia/Kuala_Lumpur')).toMatchObject({ date: '2026-10-03', hour: 15, weekday: 6 })
    expect(dayType(at('12:00', '2026-10-03'), 'Asia/Kuala_Lumpur', [])).toBe('weekend')
    expect(dayType(at('12:00', '2026-10-05'), 'Asia/Kuala_Lumpur', [])).toBe('weekday')
    expect(dayType(at('12:00', '2026-10-05'), 'Asia/Kuala_Lumpur', ['2026-10-05'])).toBe('holiday')
    expect(at('15:01') - at('15:00')).toBe(MINUTE)
  })
})
