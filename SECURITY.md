# Security Policy

## Reporting a vulnerability

Please do not publish credentials, WhatsApp session files, message databases, authentication cookies, API tokens, phone-number datasets, or other sensitive material in a public issue.

For a security vulnerability in ChatRail itself, use GitHub's private vulnerability reporting feature when available. If private reporting is unavailable, open a minimal issue that contains no exploit secret or private user data and ask for a private contact channel.

## Sensitive local files

Treat these as secrets or private runtime data:

- `.env`
- `data/`
- `logs/`
- `.wwebjs_cache/`
- browser profiles and LocalAuth directories
- Baileys credential stores
- exported message/contact datasets

The repository `.gitignore` excludes these paths. Verify staged files before every public push.

## Network exposure

ChatRail binds to `127.0.0.1` by default. If you intentionally expose it beyond loopback, configure `API_TOKEN` and place it behind appropriate network controls.
