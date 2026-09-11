# HTTP API

Default base URL:

```text
http://127.0.0.1:3333
```

All responses are JSON. When `API_TOKEN` is configured, send:

```text
Authorization: Bearer <token>
```

## Routes

- `GET /health`
- `GET /status`
- `GET /recipients`
- `POST /recipients`
- `POST /send`
- `GET /sends`
- `GET /messages`
- `GET /replies`
- `GET /reply-state?phone=...`
- `GET /chats`
- `GET /unread`
- `POST /mark-read`
- `GET /events`
- `GET /unresolved`

## Live unread state

`GET /unread` reads WhatsApp's current unread counters. The counters are authoritative provider state. When message details are requested, ChatRail returns the latest unique inbound messages it can load for each unread chat as a best-effort snapshot; WhatsApp Web does not expose a separate unread-message boundary through this integration.

Query parameters:

- `includeMessages=1|0`
- `maxMessagesPerChat=<number>`

This endpoint is read-only. It does not call `sendSeen` or otherwise mark chats as read.

## Sending

Outbound sends are guarded by the configured recipient allowlist, WhatsApp registration checks, group policy, deduplication, and optional idempotency keys.

Example request body:

```json
{
  "phone": "+15551234567",
  "text": "Hello",
  "idempotencyKey": "example-001"
}
```

Register the recipient first unless `ALLOW_UNREGISTERED=true`.
