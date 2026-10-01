import type { Settings } from './settings.ts'
import { MINUTE } from './time.ts'

export type BandType = 'adult' | 'kid' | 'under2'
export type GroupType = 'walkin' | 'party'
export type LaneId = 'in' | 'out'
export const LANES: LaneId[] = ['in', 'out']

export function normalizeBarcode(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase()
}

export function bandTypeFromBarcode(barcode: string, prefixes: Settings['bandPrefixes']): BandType | null {
  const code = normalizeBarcode(barcode)
  // Longest prefix first so "K-" never shadows a longer prefix such as "KU-".
  const ordered = (Object.entries(prefixes) as [BandType, string][]).sort((a, b) => b[1].length - a[1].length)
  for (const [type, prefix] of ordered) {
    if (prefix && code.startsWith(prefix) && code.length > prefix.length) return type
  }
  return null
}

/** True when this band type counts as a child for the kids exit rule. */
export function isChild(type: BandType): boolean {
  return type === 'kid' || type === 'under2'
}

/**
 * Overtime blocks due when leaving at `now`, counted from the end of play time.
 * Play ends 3:00 → leaving 3:20 = 1 block, 3:40 = 2 blocks.
 */
export function overtimeBlocks(now: number, playEnd: number, blockMinutes: number): number {
  if (now <= playEnd) return 0
  return Math.ceil((now - playEnd) / (blockMinutes * MINUTE))
}

export interface GroupClock {
  type: GroupType
  status: 'active' | 'closed'
  firstScanAt: number | null
  /** Walk-in: first scan + session length. Party: end of the party block. Null until a walk-in's first scan. */
  playEndAt: number | null
  partyStartAt: number | null
  extensionMinutes: number
  blocksPaid: number
  clearedAt: number | null
}

export type GroupPhase = 'not_started' | 'playing' | 'grace' | 'overtime' | 'cleared' | 'closed'

export interface GroupTiming {
  phase: GroupPhase
  started: boolean
  effectiveEnd: number | null
  graceEnd: number | null
  msLeft: number | null
  blocksDue: number
  blocksOwed: number
  exitLocked: boolean
}

export function groupTiming(g: GroupClock, s: Settings, now: number): GroupTiming {
  const started = g.type === 'party' ? g.partyStartAt !== null && now >= g.partyStartAt : g.firstScanAt !== null
  const effectiveEnd = g.playEndAt === null ? null : g.playEndAt + g.extensionMinutes * MINUTE
  const grace = (g.type === 'party' ? s.partyGraceMinutes : s.graceMinutes) * MINUTE
  const graceEnd = effectiveEnd === null ? null : effectiveEnd + grace

  let blocksDue = 0
  let exitLocked = false
  if (effectiveEnd !== null && graceEnd !== null && now > graceEnd) {
    blocksDue = overtimeBlocks(now, effectiveEnd, s.overtimeBlockMinutes)
    const inClearWindow = g.clearedAt !== null && now <= g.clearedAt + s.clearExitWindowMinutes * MINUTE
    exitLocked = blocksDue > g.blocksPaid && !inClearWindow
  }
  const blocksOwed = Math.max(0, blocksDue - g.blocksPaid)

  let phase: GroupPhase
  if (g.status === 'closed') phase = 'closed'
  else if (!started || effectiveEnd === null) phase = 'not_started'
  else if (now <= effectiveEnd) phase = 'playing'
  else if (graceEnd !== null && now <= graceEnd) phase = 'grace'
  else phase = exitLocked ? 'overtime' : 'cleared'

  return {
    phase,
    started,
    effectiveEnd,
    graceEnd,
    msLeft: effectiveEnd === null ? null : effectiveEnd - now,
    blocksDue,
    blocksOwed,
    exitLocked,
  }
}

export type DecisionCode =
  | 'ok_in'
  | 'ok_out'
  | 'closed_exit'
  | 'fire'
  | 'manual'
  | 'not_active'
  | 'already_inside'
  | 'see_host'
  | 'adult_first'
  | 'party_not_started'
  | 'party_ended'
  | 'play_ended'

export const MESSAGES: Record<DecisionCode, string> = {
  ok_in: 'Enjoy!',
  ok_out: 'See you again!',
  closed_exit: 'See you again!',
  fire: 'Emergency — gates open',
  manual: 'Gate opened by staff',
  not_active: 'Band not active',
  already_inside: 'Please see our host',
  see_host: 'Please see our host',
  adult_first: 'Adult must scan out first',
  party_not_started: 'Your party has not started yet',
  party_ended: 'Party time has ended',
  play_ended: 'Play time has ended',
}

/** Refusals that need a supervisor's attention right away. */
export const ALERT_CODES: DecisionCode[] = ['adult_first', 'see_host', 'already_inside']
