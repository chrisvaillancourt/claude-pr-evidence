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

declare module 'claude-code' {
  interface PluginState {
    'pr-evidence': { session: Shaped<Session> }
  }
}
