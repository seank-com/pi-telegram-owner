# Telegram owner design

One owner and one private chat are configured per project. The bridge durably
classifies every update before advancing its cursor, serializes work and records
outcomes in its forward-only JSONL journal. Restart recovery reconciles accepted
input, dispatched jobs, replies, commands, photos and transient activity without
resending uncertain outcomes. Source evidence is retained; extraction changes no
journal, cursor, archive or importer schema identifier.

Canonical Markdown is authoritative. The projector joins exact Telegram text
segments by owner, conversation and timestamp, preserves individual membership
and provenance, and atomically publishes identified notes. Transport chunks are
not archive messages. Session evidence, media events, predecessor links, source
ranges and hashes reconcile live and imported material. Indexes are disposable.
Photos are captured before dispatch; attachments and media lifecycle receipts
preserve identity across restart. Source Markdown and binary media are never
replaced by search output. OS ownership and permissions define authority.

The archive importer validates source manifests, speaker maps, Pi boundary
anchors and explicit admitted sessions. Dry-run binds a content-free checkpoint
to exact inputs. Commit requires that plan, protected output and atomic idempotent
publication. Unsupported markup, changed source, corrupt state or cancellation
fails explicitly. Source files, session JSONL and journals are not indexed.

Datastore integration is a narrow consumer of v1 capability/RPC wire shapes.
`auto` discovers synchronously on Pi's existing event bus, requiring ready=true,
contractVersion=1 and the exact configured store. `off` does no discovery or RPC.
`required` does not downgrade to auto; missing service preserves transport and
archive with a persistent CAPABILITY_UNAVAILABLE diagnostic and immediate recall
failure. No installed module is taken as proof of an active extension.

Recall registers during initialization. The supported active-tool API disables
it at session start when optional integration is absent and re-evaluates at
resources_discover, after all session-start handlers. Real-host tests establish
this timing and both load orders. Required recall remains visible for an explicit
bounded failure. Invocation rechecks readiness and store identity; a stale active
tool cannot silently gain a different store. Reload/teardown aborts the consumer's
RPC lifetime and disables recall; restart creates a new lifetime.

Recall fixes hybrid retrieval, content inclusion and a 1–10 result limit; the
result text retains the 50 KiB/2000-line ceiling. Requests retain the accepted 15-minute default
consumer deadline (factory-injectable for tests), propagate caller cancellation,
and send a parent-owned AbortSignal plus deadline through the RPC envelope.
Timeout and shutdown abort owned backend work, reject the caller, and discard
late replies. The datastore still owns search/index validation and atomic refresh.

After successful Markdown publication, lexical refresh requests are coalesced.
They are sent only while the exact optional integration is active, never queued
against an absent service. Accepted datastore semantic-refresh scheduling remains
owned by datastore; Telegram does not add workers, model downloads or semantic
refresh loops. Injected transport fixture callbacks exercise coalescing without
starting real services.

Activity consumes only validated versioned persisted audit data. Existing safe
activity validation remains a Telegram display responsibility; it does not copy
observability's sanitizer/redactor. Without a valid audit entry, activity falls
back to a bounded tool name. Raw tool arguments are never displayed. Persisted
identifiers/types are checked against the owner's actual packed contract.

Native CLIs/archive helpers import no Pi runtime values. The extension supplies
Pi's CONFIG_DIR_NAME; the menu CLI defaults to .pi with an explicit override.
Runtime dependencies are declared parsing libraries; TypeBox and Pi remain host
peers for extension loading. Compiled ESM/declarations and both executable CLI
shebangs ship. No tests, private operational content or sibling source imports
are included in the package.

The operation event is `pi-markdown-datastore:v1:request`; discovery remains
`pi-markdown-datastore:v1:capability-request` and
`pi-markdown-datastore:v1:capability-reply`. Pre-release datastore and consumer
candidates must be rebuilt together: the earlier request-event name has no
compatibility alias. Protocol version and envelope fields are unchanged.

## Archive schema ownership

Archive and importer schemas are package-owned `pi-telegram-owner/<kind>/v1`
identifiers. The boundary has one strict shape: explicit `admittedPiSessionIds`
and `firstPi.matchKind` are required. Both semantic Markdown and raw-source
matching remain supported; omitting the match mode or session list is invalid.
No former names or boundary versions are accepted. Reports and checkpoints also
start at v1 in this namespace, retaining the current plan-binding and restart
semantics. Source evidence, transport journal formats and cursors are unchanged.
Existing export files can be reused for a fresh import with regenerated controls
and a separate output archive; see [setup](setup.md).
