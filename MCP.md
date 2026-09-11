# ChatRail MCP

ChatRail includes a Model Context Protocol stdio server.

The MCP server does not connect to WhatsApp directly. It calls the ChatRail HTTP daemon so that only one process owns the WhatsApp session.

## Start

Terminal 1:

```powershell
npm start
```

MCP process:

```powershell
npm run mcp
```

Optional environment variables:

```text
MCP_API_BASE_URL=http://127.0.0.1:3333
MCP_API_TIMEOUT_MS=15000
API_TOKEN=
```

## Tools

- `get_status`
- `get_health`
- `list_recipients`
- `register_recipient`
- `send_message`
- `list_sends`
- `list_messages`
- `list_replies`
- `get_reply_state`
- `list_chats`
- `list_unread_chats`
- `mark_read`
- `list_events`
- `list_unresolved`

## Resources

- `chatrail://status`
- `chatrail://recipients`
- `chatrail://replies`
- `chatrail://unresolved`
- `chatrail://recipient/{phone}/reply-state`

Write-capable tools should only be invoked with appropriate user authorization.
