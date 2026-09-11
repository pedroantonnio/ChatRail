# Architecture

ChatRail is an integration gateway, not an AI decision engine.

```text
Client / Agent / Automation
        |
   HTTP or MCP
        |
  ChatRail service
        |
 Provider adapter
   /          \
wwebjs      Baileys
        |
     WhatsApp
```

## Single provider owner

Only the HTTP daemon owns the real WhatsApp provider and authentication session.

The MCP server is a stdio adapter that calls the local HTTP API. This prevents two processes from competing for the same WhatsApp Web authentication profile.

## Main components

- `src/service.js`: domain operations, safety checks, persistence coordination.
- `src/store.js`: JSON-backed local operational state.
- `src/http.js`: loopback HTTP API.
- `src/api-client.js`: HTTP client used by MCP.
- `src/mcp/server.js`: MCP tools, resources, and prompts.
- `src/providers/`: provider adapters.
- `src/normalize.js`: phone and text normalization.

## Runtime data

Runtime state is stored under `data/` by default and is ignored by Git. Authentication state is sensitive and must never be committed.
