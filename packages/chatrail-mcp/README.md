# @pedroantonnio/chatrail-mcp

Lightweight MCP stdio bridge for the ChatRail WhatsApp gateway.

The ChatRail daemon must already be running. This package does not open a WhatsApp session; it connects to the local ChatRail HTTP API.

## Codex

Install in Codex with:

    codex mcp add chatrail -- npx -y @pedroantonnio/chatrail-mcp

Verify with:

    codex mcp list

By default the bridge connects to http://127.0.0.1:3333.

Supported environment variables:

- CHATRAIL_HOME
- MCP_API_BASE_URL
- CHATRAIL_API_BASE_URL
- MCP_API_TIMEOUT_MS
- API_TOKEN
