# ContextFidelity

ContextFidelity is an open-source, local-first chat workspace that keeps conversations on topic. It selects relevant saved context for each question and shows the exact context and source evidence sent with every answer.

[한국어](README.ko.md)

## What it does

- Automatically identifies the topic of a question and retrieves related context from the current project.
- Registers useful information from user messages with links to the original conversation. Assistant-generated suggestions stay as hypotheses until reviewed.
- Keeps user-stated conversation criteria versioned and separate from background information, so an explicit change can replace an earlier criterion without losing its history.
- Generates an answer, checks it against the available conversation evidence, and can correct one detected conflict before checking again.
- Shows an answer receipt with the actual model input, included and excluded context, search scores, and source messages. Past receipts preserve the content used at the time of the answer.
- Lets users edit, scope, search, archive, restore, and delete context items, and delete conversations.

## Context selection

Saved context is searched with SQLite FTS5. The default score combines keyword matches (70%) and topic matches (30%); up to eight items scoring at least 50% are selected. Per-conversation include and exclude choices are also supported. This is keyword retrieval, not embedding-based semantic search, so a paraphrase with no overlapping terms may fail to find relevant context.

## Model and data

Users connect ChatGPT once and choose an available model in the chat composer. Context analysis, extraction, validation, and correction may make additional requests through the connected ChatGPT plan. Existing ChatGPT conversations are not imported.

By default, conversation and context data are stored in the app's SQLite workspace. OAuth credentials are stored separately on the server and excluded from exports. Hosted mode isolates each visitor's workspace. An answer receipt records the request that was sent; it does not establish how much the model attended to or relied on any particular context.

## Prototype limits

The project is a working prototype. It does not provide semantic or embedding search, and its conflict-checking accuracy has not been benchmarked. The fixed correction walkthrough demonstrates the review flow without making model calls; it is not an accuracy evaluation.

## License

Apache-2.0. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
