# ContextPulse

A local-first, open-source chat workspace that automatically selects the context needed for each question and preserves the exact context sent to each model call.

## Run locally

Use Node.js 24 or newer:

```sh
npm install
npm run build
npm start
```

Open http://127.0.0.1:8899. English is the default; Korean is available at `/ko/`. Both routes share the same projects and conversations. See [한국어 안내](README.ko.md).

## What the prototype does

- Connect a ChatGPT account using the official OAuth flow, an OpenAI API key, or a local Ollama model.
- Keep the selected model when navigating, refreshing, or reconnecting the same account.
- Store references, background, and hypotheses with topic and project scopes.
- Identify topics automatically from each question; no topic input is required. Select relevant context by question meaning while retaining manual choices.
- Generate a draft, validate it against original conversation evidence, correct a conflict once, and revalidate.
- Show the topic, stored context, conversation context, and earlier messages sent for each answer directly below that answer.
- Compare immutable request bodies across stages or answers, and inspect original sources.
- Automatically register useful context from user messages and assistant responses without save buttons. Assistant proposals remain topic-scoped hypotheses. Exact source quotes are checked before any registration.
- Display the answer after validation while automatic registration finishes, with language-specific stage progress.

## Connecting a model

In Settings, choose **Continue with ChatGPT**, complete sign-in and consent, then select a model from your account's catalog. Supported requests use the connected ChatGPT plan; validation, correction, selection, and extraction can add calls. Existing ChatGPT conversations are not imported. OAuth and API-key billing paths remain separate.

For Ollama, choose the local provider and a loopback URL such as `http://127.0.0.1:11434`. This prototype restricts that endpoint to local addresses.

## Data and evidence

Original messages, versioned context, automatic-registration candidates, and model-call snapshots are stored in `data/contextpulse.sqlite`. Credentials are held separately in a server-only local file with restrictive permissions, and are excluded from exports. OS keychain integration is not implemented. Local mode stays bound to loopback. Hosted mode uses isolated visitor databases and encrypted visitor API keys; see the deployment guide.

The user-facing prototype does not expose a separate decision-management screen or a manual decision-registration checkbox. Conversation criteria are kept as internal evidence for validation and are shown as conversation context inside each answer receipt. See [the current project summary](docs/project-summary.md) for the product scope and demo flow.

“Context sent” is a receipt of the actual preserved request inputs; it does not measure model attention or prove how much an input influenced the answer. Editing a context item does not change earlier receipts. The fixed correction demo is labeled and makes no model calls. Real-world detection accuracy has not been benchmarked.

English and Korean application copy and prompts are separate. Original user messages and historical model outputs are preserved, so they may be in either language.

## Hosted demo and Cloudflare

Run `docker compose -f compose.yaml up -d --build` and open `http://127.0.0.1:8903`. This tests hosted mode locally with separate data. Public deployment uses a persistent origin behind Cloudflare Tunnel, with its own configuration. No public tunnel is started by the test configuration. See [Cloudflare demo guide](docs/cloudflare-demo.md).

## Verification

```sh
npm test
node scripts/diagnose-connection.mjs
```

Tests cover original-source preservation, project isolation, selection overrides, correction grounding, exact payload storage, per-answer receipts, early answer availability, route localization, OAuth validation, token rotation, and error diagnostics. The diagnostic script uses isolated temporary data and simulated OAuth/inference; it does not use your account. Real model testing is reported separately.

`src/client.js` and `src/client.html` are the shared UI sources. `npm run build` generates English/Korean assets and CSS. Restart the server after changes so the runtime and generated interface use the same build.

## License

Apache-2.0. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
