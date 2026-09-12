# ChatRail agent instructions

ChatRail is a local WhatsApp gateway. The daemon owns the WhatsApp session and exposes the local HTTP API.

When asked to install the ChatRail MCP for Codex, use this command:

    codex mcp add chatrail -- npx -y @pedroantonnio/chatrail-mcp

Then validate with:

    codex mcp list

The ChatRail daemon must run separately.

For npm installations, initialize and start it with:

    chatrail init
    chatrail start

Do not start a second WhatsApp provider from the MCP process.

Do not bypass recipient allowlist, deduplication, idempotency, identity, or group-send safeguards.

Before publishing packages, run:

    npm run verify
    npm run verify:mcp
    npm run pack:check