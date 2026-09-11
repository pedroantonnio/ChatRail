# Known upstream limitations

ChatRail depends on unofficial WhatsApp Web integrations. Provider behavior can change when WhatsApp changes its web client or protocol.

## whatsapp-web.js

Fresh installs default to `whatsapp-web.js` because it currently provides the most reliable first-time QR pairing path in this project.

Its Puppeteer/browser dependency chain may surface security advisories in `npm audit` that ChatRail cannot safely fix by forcing incompatible transitive versions. Review `npm audit` output when deploying and update pinned dependencies when compatible upstream fixes become available.

## Baileys

Baileys support is available and is preferred automatically when an existing Baileys credential set is present.

Fresh QR pairing behavior can vary across Baileys release candidates and WhatsApp protocol changes. If a new Baileys pairing fails, use the default `auto` provider or `wwebjs`.

## WhatsApp Web internals

Some read-only features, including live unread inspection, depend on WhatsApp Web runtime collections because the high-level library API does not expose every state needed by ChatRail. These integrations are isolated in the provider adapter and can require maintenance after upstream web-client changes.

## Project policy

ChatRail does not silently guess opaque WhatsApp LIDs into phone numbers and does not bypass outbound safety controls to work around upstream failures.
