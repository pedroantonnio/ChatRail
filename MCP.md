# ChatRail MCP

ChatRail provides a Model Context Protocol stdio bridge.

The MCP process does not connect to WhatsApp directly. It calls the ChatRail HTTP daemon so that only one process owns the WhatsApp session.

## Codex installation

Start ChatRail first:

~~~powershell
chatrail start
~~~

Register the published MCP package:

~~~powershell
codex mcp add chatrail -- npx -y @pedroantonnio/chatrail-mcp
~~~

Verify:

~~~powershell
codex mcp list
~~~

Codex starts and stops the stdio MCP process automatically.

## Local development

When working from this repository, the MCP entrypoint can still be started manually for debugging:

~~~powershell
npm run mcp
~~~

Optional environment variables:

~~~text
CHATRAIL_HOME=
MCP_API_BASE_URL=http://127.0.0.1:3333
CHATRAIL_API_BASE_URL=
MCP_API_TIMEOUT_MS=15000
API_TOKEN=
~~~

## Tools

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

## Resources

- chatrail://status
- chatrail://recipients
- chatrail://replies
- chatrail://unresolved
- chatrail://recipient/{phone}/reply-state

Write-capable tools should only be invoked with appropriate user authorization.