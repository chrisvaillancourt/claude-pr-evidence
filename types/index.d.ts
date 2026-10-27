export type Mode = 'on' | 'off'

/** The options in plugin.json's userConfig, parsed with defaults filled in. */
export type Config = {
  enabled: boolean
  allowSubagents: boolean
  timeoutSeconds: number
  maxOutputKiB: number
}

/** What the mod keeps for the session. Lives in $.state, so it survives a hot reload. */
export type Session = {
  /** A /pr-evidence on|off override for this session; null follows the `enabled` option. */
  mode: Mode | null
}

/**
 * The override as kept in `$.store` under `mode/<session id>`, so it survives the
 * session moving to a new process (where `$.state` reads empty). `at` is refreshed on every write.
 */
export type ModeRecord = { mode: Mode; at: number }

declare module 'claude-code' {
  interface PluginState {
    'pr-evidence': { session: Shaped<Session> }
  }
}
