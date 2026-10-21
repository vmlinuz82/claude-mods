// One model request of the main conversation that read or wrote the cache
export type CacheRequest = {
  // When the request started: the cache lifetime counts from the start, not the end
  at: number
  read: number
  written: number
  fresh: number
  output: number
  model: string
  effort: string | null
}

// How long the main conversation's cache lasts, and how the mod knows
export type Lifetime = {
  ms: number
  // setting: promptCacheTtl or one of its environment variables; default: Claude Code's default for
  // this kind of account; observed: what the cache actually did after a pause
  source: 'setting' | 'default' | 'observed'
}

// Token counts and their cost, in full-price input tokens: read, written and output weighted by their price
export type Tally = {
  requests: number
  read: number
  written: number
  fresh: number
  output: number
  cost: number
  // What the same requests would have cost with no cache at all
  costWithoutCache: number
}

// One turn of the main conversation, its requests summed
export type TurnSummary = Tally & {
  turnId: string
  at: number
  // Why the turn's first request rebuilt the cache instead of reading it; null when it read it
  rebuiltBecause: string | null
  // The same, as one short word for the session's count: expired, model switch, effort change, /compact, unknown
  rebuildKind: string | null
}

// The one-hour cache against the five-minute one, in full-price tokens: pauses between 5 and 60 minutes the hour
// carries over (kept), against what its dearer writes cost on everything written (extra)
export type HourVsFive = {
  pauses: number
  kept: number
  extra: number
}

// The whole session so far: its turns, how many times each kind of rebuild happened, and the hour against five minutes
export type SessionTally = Tally & {
  turns: number
  rebuilds: Record<string, number>
  hour: HourVsFive
}

declare module 'claude-code' {
  interface PluginState {
    // last: the latest request that used the cache; turns: newest first; window: the model's context window in
    // tokens; clock: the time as last read; isExpanded: the details opened under the one-line strip
    'cache-meter': {
      isExpanded: boolean
      last: CacheRequest | null
      lifetime: Lifetime
      turns: TurnSummary[]
      session: SessionTally
      window: number | null
      clock: number
    }
  }
}
