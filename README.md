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

See the [current prototype scope](docs/project-summary.md) and [Colosseum submission checklist](docs/submission-readiness.md).

## What the prototype does

- Sign in once with ChatGPT from the lower-left sidebar, then choose a model in the chat composer.
- Keep the selected model when navigating, refreshing, or reconnecting the same account.
- Store references, background, and hypotheses with topic and project scopes.
- Search, archive, restore, or delete individual context items and their version history.
- Identify topics automatically, then use SQLite FTS5 keyword matches and a visible score threshold to retrieve up to eight relevant context items. Chat-specific choices and always-included items are retained.
- Generate a draft, validate it against original conversation evidence, correct a conflict once, and revalidate.
- Show the topic, stored context, conversation context, and earlier messages sent for each answer directly below that answer.
- Compare immutable request bodies across stages or answers, and inspect original sources.
- Automatically register useful context from user messages without save buttons. Assistant proposals remain topic-scoped hypotheses in a review queue and are not sent to later answers until approved. Exact source quotes are checked before registration.
- Manage user-stated conversation criteria separately: inspect the original source, archive, restore, or delete a full criterion chain.
- Delete an individual conversation with its messages, answers, call records, and context derived from that conversation; an empty chat is created if it was the last one.
- Delete all projects, conversations, context, decisions, answers, and model-call records from Settings while retaining sign-in and app preferences.
- Follow the message language and repair a detectable language or exact-list-count mismatch once before showing the answer.
- Display the answer after validation while automatic registration finishes, with language-specific stage progress.

## Connecting a model

Sign in once with ChatGPT using the lower-left sidebar button. After sign-in, select an available model directly in the chat composer; the choice applies across conversations. Validation, correction, selection, and extraction can add model calls. Existing ChatGPT conversations are not imported. The app does not expose API-key or local-model setup as alternate chat providers. The fixed correction walkthrough is separate and clearly marked as a no-model-call example.

## Data and evidence

Original messages, versioned context, automatic-registration candidates, and model-call snapshots are stored in `data/contextpulse.sqlite`. Credentials are held separately in a server-only local file with restrictive permissions, and are excluded from exports. OS keychain integration is not implemented. Local mode stays bound to loopback. Hosted mode uses isolated visitor databases and encrypts each visitor's OAuth credentials; see the deployment guide.

Conversation criteria have their own tab inside Context manager, with source evidence and archive/restore/delete controls. Assistant-generated hypotheses wait for approval before becoming searchable context. Deleting a context or criterion keeps immutable receipts for past answers. See [the current project summary](docs/project-summary.md) for the product scope and demo flow.

“Context sent” is a receipt of the actual preserved request inputs; it does not measure model attention or prove how much an input influenced the answer. Editing a context item does not change earlier receipts. The fixed correction demo is labeled and makes no model calls. Real-world detection accuracy has not been benchmarked.

Automatic context retrieval uses SQLite FTS5 over context titles, content, and topic labels. It ranks keyword matches with BM25 and applies a transparent keyword/topic coverage score and threshold; it does not use embeddings or semantic search, so synonyms and paraphrases without shared terms can be missed. The receipt records the search terms, score details, threshold, and contexts actually sent.

English and Korean application copy and prompts are separate. Original user messages and historical model outputs are preserved, so they may be in either language.

## Hosted demo and Cloudflare

Run `docker compose -f compose.yaml up -d --build` and open `http://127.0.0.1:8903`. This runs the same chat, ChatGPT OAuth, composer model selection, and context features in hosted mode, with visitor-isolated data. Public deployment uses a persistent origin behind Cloudflare Tunnel, with its own configuration. OpenAI's open-source OAuth flow only accepts loopback callbacks; a public HTTPS website needs an OpenAI-registered website login client before ChatGPT sign-in can be enabled. Do not publish the public hostname as a live-model demo until that callback is registered. No public tunnel is started by the test configuration. See [Cloudflare demo guide](docs/cloudflare-demo.md).

## Verification

```sh
npm test
node scripts/diagnose-connection.mjs
```

Tests cover original-source preservation, project isolation, selection overrides, correction grounding, exact payload storage, per-answer receipts, early answer availability, route localization, OAuth validation, token rotation, and error diagnostics. The diagnostic script uses isolated temporary data and simulated OAuth/inference; it does not use your account. Real model testing is reported separately.

`src/client.js` and `src/client.html` are the shared UI sources. `npm run build` generates English/Korean assets and CSS. Restart the server after changes so the runtime and generated interface use the same build.

## License

Apache-2.0. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
