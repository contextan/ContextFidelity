# Cloudflare demo: test first, publish separately

The current implementation runs a persistent Node.js origin behind Cloudflare Tunnel. Tunnel maps the public HTTPS hostname to this server; it does not host the server or SQLite itself. Keep the origin machine/VM running with a persistent Docker volume. The official setup requires a server or VM and a domain on Cloudflare: [Cloudflare Tunnel setup](https://developers.cloudflare.com/tunnel/get-started/).

This is not a Workers deployment. Workers' temporary filesystem is not persistent between requests; a Workers-only implementation needs a separate D1/storage adapter: [Workers filesystem](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/).

## Local hosted-mode test

```sh
docker compose -f compose.yaml up -d --build
```

Open `http://127.0.0.1:8903` (English) or `/ko` (Korean). This port binds only to loopback. The `contextpulse-test_demo-data` volume is separate from the existing local application's `data/`; private conversations and ChatGPT credentials are never copied into the image or demo volume.

Check the health status with `docker compose -f compose.yaml ps`. Stop without deleting data using `docker compose -f compose.yaml down`. Starting again preserves each visitor's signed cookie, encrypted API key, conversations, decisions, contexts and call snapshots. Clearing browser cookies starts a new workspace; there is no account-based recovery in this prototype.

## Public demo behavior

- Default: clearly labeled demo mode with no external model calls. The fixed correction case is available in Settings.
- Live inference: the visitor supplies their own OpenAI API key and selects a model. There is no shared operator account or inference key.
- ChatGPT plan OAuth and local Ollama are offered only in local mode. The OpenAI OSS sign-in flow requires an exact `127.0.0.1` loopback callback, so it is not reused on a public hostname: [OpenAI OSS sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in).
- Visitor sessions use signed HttpOnly/SameSite cookies, Secure on HTTPS. Databases and credentials are isolated per visitor; foreign visitor IDs cannot address another database.
- API keys are encrypted using AES-256-GCM. The encryption/signing root key lives in the same protected data volume. Back up the entire volume, including `workspace.key`; operators with access to this volume can decrypt the credentials. This is not protection against full-volume theft.
- Exact request bodies and source messages are preserved. Exports exclude credential files and encryption keys. SQLite downloads use a consistent native backup, including committed WAL contents.
- Basic prototype limits: 500 stored visitor workspaces, 64 cached DB connections, 20 new workspaces/minute globally, 240 requests/minute per cached visitor, up to 2 concurrent projects per visitor and 8 globally. Expired workspaces are not automatically purged; perform retention planning before a longer public run. These process-level controls supplement, rather than replace, Cloudflare's edge controls.

## Publish later

Do not run the following configuration until the public hostname and origin server are chosen.

1. Create a remotely managed Cloudflare Tunnel and configure a published application route to `http://app:8899`.
2. Preserve the public Host header, or set **HTTP Host Header** to the hostname in `PUBLIC_ORIGIN`. The app checks Host and Origin exactly and ignores forwarded-host claims: [origin parameters](https://developers.cloudflare.com/tunnel/reference/origin-parameters/).
3. Save the tunnel token in a protected file outside the repository (readable by the tunnel container). Set `PUBLIC_ORIGIN=https://your-demo-hostname` and `TUNNEL_TOKEN_FILE=/absolute/path/to/the/token-file` in the deployment environment. No real domain or token is included here.
4. Start `docker compose -f compose.cloudflare.yaml up -d --build`. This separate configuration exposes no origin port on the host. The tunnel reads the token using the official `--token-file` option: [run parameters](https://developers.cloudflare.com/tunnel/reference/run-parameters/).
5. Verify HTTPS, Secure cookies, English/Korean routes and visitor isolation at the public hostname before submitting its URL. Public tunnel/HTTPS verification has not been performed yet.

Run one origin process per data volume. Multiple replicas writing to one SQLite volume are not supported by this prototype. Keep the volume across container updates and back it up independently of the source code/image. The server handles termination by draining current work for up to 30 seconds; longer model requests are recovered as interrupted on restart, with an already validated answer retained.

## Verification commands

```sh
npm test
node scripts/audit-db.mjs data/contextpulse.sqlite outputs/database-audit.json
node scripts/diagnose-connection.mjs
```

`test-auto-flow.mjs` is an optional real-model integration test for the local app. It makes billable/plan calls through the currently selected connection and creates a named test project. It checks automatic registration from both speakers, current-turn criterion application, topic return and frozen answer receipts. It is not a semantic-accuracy benchmark.
