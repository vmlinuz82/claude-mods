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
    // closedAt: the total uses when the band was closed; the band stays hidden until a new use
    'skill-usage': { catalog: Catalog; counts: Counts; closedAt: number | null }
  }
}
