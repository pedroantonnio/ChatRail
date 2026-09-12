# ChatRail

A local WhatsApp gateway with HTTP and MCP interfaces.

ChatRail connects applications, automations, and AI runtimes to WhatsApp without pretending to be the AI agent itself.

~~~text
Apps / Automations / AI
          |
      HTTP / MCP
          |
       ChatRail
          |
       WhatsApp
~~~

ChatRail owns the WhatsApp session, normalizes identities, persists operational state, exposes a loopback HTTP API, and provides an MCP interface. Your application or AI runtime supplies the business logic.

## What it does

- Connects to WhatsApp through whatsapp-web.js or Baileys.
- Persists local authentication so QR pairing is normally one-time.
- Exposes a local HTTP API on 127.0.0.1:3333 by default.
- Exposes an MCP stdio bridge backed by that HTTP API.
- Sends text messages with registration checks, deduplication, and idempotency.
- Resolves modern WhatsApp @lid identities without treating opaque LIDs as phone numbers.
- Lists observed chats, messages, replies, delivery/read acknowledgements, and unresolved identities.
- Reads the actual WhatsApp unread counters and returns a best-effort snapshot of recent inbound messages for those unread chats, including groups, without marking anything as read.
- Normalizes media in unread listings to message types instead of leaking thumbnail/base64 payloads.
- Stores contact display metadata when WhatsApp exposes it.
- Keeps the real WhatsApp provider in one process; MCP never creates a second competing session.

## Requirements

- Node.js 20 or newer
- npm
- Internet access
- A WhatsApp account able to pair WhatsApp Web

## Install from npm

Install ChatRail globally:

~~~powershell
npm install -g @pedroantonnio/chatrail
chatrail init
chatrail start
~~~

The first command installs the CLI. The init command creates the runtime directory under your user profile, normally ~/.chatrail, including the local configuration file and data directories.

On first use with the default auto provider, ChatRail normally starts whatsapp-web.js and prints a QR code. Scan it from WhatsApp under linked devices.

Useful CLI commands:

~~~powershell
chatrail start
chatrail status
chatrail doctor
chatrail home
~~~

The local API defaults to:

~~~text
http://127.0.0.1:3333
~~~

## Codex MCP

Keep the ChatRail daemon running:

~~~powershell
chatrail start
~~~

Register the lightweight MCP bridge with Codex:

~~~powershell
codex mcp add chatrail -- npx -y @pedroantonnio/chatrail-mcp
~~~

Verify the registration:

~~~powershell
codex mcp list
~~~

The MCP bridge talks to the local ChatRail HTTP API. It does not create another WhatsApp client.

Once registered, you can ask Codex things such as:

~~~text
Use ChatRail to check my unread WhatsApp chats.
~~~

The MCP package is intentionally separate from the daemon package so MCP clients do not need to install the WhatsApp provider and browser dependencies.

## Local development

Clone and install:

~~~powershell
git clone https://github.com/pedroantonnio/ChatRail.git
cd ChatRail
npm install
Copy-Item .env.example .env
npm run verify
npm start
~~~

When a ChatRail project .env is present in the repository, local development keeps using the repository directory for runtime state. Global installations use ~/.chatrail by default. CHATRAIL_HOME can override the runtime location explicitly.

## MCP development

The repository still includes the MCP implementation for development and tests.

Start the daemon:

~~~powershell
npm start
~~~

Run the repository MCP entrypoint manually only for debugging or MCP inspector use:

~~~powershell
npm run mcp
~~~

For normal Codex use, let Codex start the published stdio bridge itself.

Core tools include:

- get_status
- get_health
- list_recipients
- register_recipient
- send_message
- list_sends
- list_messages
- list_replies
- get_reply_state
- list_chats
- list_unread_chats
- mark_read
- list_events
- list_unresolved

See MCP.md for integration details.

## HTTP API

Important routes:

| Method | Route | Purpose |
| --- | --- | --- |
| GET | /health | API/provider health |
| GET | /status | Runtime status and safeguards |
| GET | /recipients | Registered outbound recipients |
| POST | /recipients | Register an outbound recipient |
| POST | /send | Send a text message |
| GET | /sends | Outbound send history |
| GET | /messages | Locally persisted messages |
| GET | /replies | Reply-eligible inbound messages |
| GET | /chats | Locally observed chat summaries |
| GET | /unread | Live unread counters plus recent inbound message snapshots |
| POST | /mark-read | Explicitly mark one recipient read |
| GET | /events | Persisted events |
| GET | /unresolved | Identities that could not be resolved safely |
| GET | /reply-state | Reply-tracking state |

See API.md.

## Safety defaults

ChatRail intentionally defaults to conservative outbound behavior:

- The HTTP server binds to loopback by default.
- Unregistered outbound recipients are blocked by default.
- Group sending is blocked by default.
- Duplicate sends are suppressed inside the configured dedupe window.
- Ambiguous @lid identifiers are not guessed into phone numbers.
- GET /unread is read-only and does not mark chats as read.
- If you bind the API outside loopback, configure API_TOKEN.

These controls reduce accidental actions. They are not a substitute for your own authorization, compliance, and rate-limit policies.

## Providers

### whatsapp-web.js

Recommended for a fresh install. It uses Chromium/Puppeteer and LocalAuth.

### Baileys

Supported as an alternative provider. auto prefers Baileys only when an existing Baileys credential set is present.

Provider behavior can change when WhatsApp Web changes. See KNOWN_UPSTREAM_LIMITATIONS.md.

## Data and privacy

Global installations store local configuration, authentication state, contact metadata, message state, and logs under ~/.chatrail by default.

Local repository development continues to use ignored paths such as data and logs when the project contains its local .env.

Never publish or commit WhatsApp authentication data, environment files, browser session data, message databases, or logs.

## Development verification

Run:

~~~powershell
npm run verify
npm run verify:mcp
npm run pack:check
~~~

Other useful commands:

~~~powershell
npm run doctor
npm run provider:smoke
npm run stress
~~~

## npm packages

- @pedroantonnio/chatrail: daemon and CLI
- @pedroantonnio/chatrail-mcp: lightweight MCP stdio bridge

Releases are prepared for npm Trusted Publishing through GitHub Actions.

## Security

See SECURITY.md. Do not report leaked WhatsApp sessions, credentials, or other sensitive material in public issues.

## License

MIT. Third-party dependencies retain their own licenses.

## Disclaimer

ChatRail is an independent, unofficial open-source project. It is not affiliated with, authorized by, maintained by, sponsored by, or endorsed by WhatsApp or Meta. WhatsApp is a trademark of its respective owner.

Use the project in accordance with applicable law, WhatsApp terms, and the consent and privacy expectations of the people you communicate with.