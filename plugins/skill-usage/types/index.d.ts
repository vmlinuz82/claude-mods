export type Catalog = {
  skills: string[]
  servers: string[]
  // MCP tool wire name → server name as /mcp lists it
  toolServers: Record<string, string>
}

export type Counts = {
  skills: Record<string, number>
  servers: Record<string, number>
}

declare module 'claude-code' {
  interface PluginState {
    'skill-usage': { catalog: Catalog; counts: Counts }
  }
}
