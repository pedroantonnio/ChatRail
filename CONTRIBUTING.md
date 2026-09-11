# Contributing

Contributions are welcome.

## Development setup

```powershell
npm install
Copy-Item .env.example .env
npm run verify
npm run verify:mcp
```

## Before opening a pull request

- Add or update tests for behavior changes.
- Run the full verification suite.
- Do not commit WhatsApp sessions, message history, logs, `.env`, browser caches, or other personal data.
- Keep provider-specific work behind the provider adapter boundary where practical.
- Preserve the rule that the HTTP daemon is the single owner of the real WhatsApp session.

## Scope

ChatRail is a gateway/integration layer. AI prompts and business-specific autonomous decision logic generally belong in applications built on top of it rather than in the core.
