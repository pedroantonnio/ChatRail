# Publishing ChatRail to npm

ChatRail is published as two public npm packages:

- @pedroantonnio/chatrail
- @pedroantonnio/chatrail-mcp

The first publication must be performed manually because npm trusted publishing can only be configured after the package already exists in the npm registry.

## Prerequisites

- An npm account that owns the pedroantonnio scope.
- Two-factor authentication enabled on the npm account.
- npm authentication on the local machine.
- All verification commands passing.

Check authentication:

    npm whoami

If needed, authenticate:

    npm login

## Preflight

Run from the repository root:

    npm run verify
    npm run verify:mcp
    npm run pack:check

Review the package contents carefully. Runtime state, WhatsApp credentials, environment files, logs, browser data, and message databases must never be present in either package.

## First publication

Publish the daemon package:

    npm publish --access public

Publish the MCP package:

    npm publish --workspace @pedroantonnio/chatrail-mcp --access public

Verify both packages:

    npm view @pedroantonnio/chatrail version
    npm view @pedroantonnio/chatrail-mcp version

## Configure Trusted Publishing

After both packages exist on npm, configure a GitHub Actions trusted publisher for each package.

Use these values:

- GitHub user or organization: pedroantonnio
- Repository: ChatRail
- Workflow file: publish.yml
- Allowed action: npm publish

Trusted Publishing requires a GitHub-hosted runner and OIDC permission. The publish workflow already grants id-token write.

Configure the trusted publisher separately for:

- @pedroantonnio/chatrail
- @pedroantonnio/chatrail-mcp

After Trusted Publishing is configured, npm publish from the GitHub workflow authenticates through OIDC and does not require a long-lived NPM_TOKEN.

For public packages from a public repository, npm automatically generates provenance when Trusted Publishing is used.

## Subsequent releases

Keep both package versions synchronized unless there is a deliberate reason not to.

Update both versions, for example to 1.0.1, run verification, commit, push, and create a GitHub Release for that version.

Publishing is triggered when the GitHub Release is published.

Do not publish the same package version twice. npm package versions are immutable once published.

## Security note

The current whatsapp-web.js release depends on a Puppeteer dependency chain that npm audit reports with high-severity extract-zip advisories. There is no newer whatsapp-web.js release available at the time this document was written that resolves the dependency chain.

Do not use npm audit fix with force automatically. That command currently proposes a dependency change that may alter runtime behavior. Review upstream releases and regression-test provider behavior before changing the pinned WhatsApp provider dependency.