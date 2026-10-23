# Setup

Build the package with Node 24.14.1+, npm ci and npm run build. Select its compiled
Pi manifest entry in the desired disposable or operator-managed project/profile.
Manual installation and runtime activation are separate operator actions.

Create a protected project configuration directory (0700) and config.json (0600):

```json
{
  "ownerUserId": 10001,
  "privateChatId": 10001,
  "tokenEnv": "TELEGRAM_BOT_TOKEN",
  "agentLabel": "Example agent",
  "formattedDelivery": true,
  "inboundQuietWindowMs": 4000,
  "datastore": { "mode": "auto", "store": "telegram" },
  "markdownProjection": { "enabled": true, "rootId": "pi-sessions" }
}
```

Place it at <project>/.pi/telegram-owner/config.json (or the selected Pi config
directory). Load the named environment variable through the operator's existing
launch mechanism. The extension validates one owner and private chat before accepting updates.

Projection defaults to the project root. An absolute markdownProjection.root and
sessionRoot may be supplied; rootId is a safe stable namespace identifier.
Optional roleSlugs defines user, assistant and command filenames. Projection may
be false; the mandatory media-event stream still records photo provenance.
Journal/lock paths remain project-local to the selected Telegram config directory.
Do not share another agent's journal, archive, session root or configured stores.
The group chat's shared root is the one deliberately shared location.

For retrieval, configure the independent datastore extension with the exact
selected store rooted at the archive's `messages/` directory, not its projection
parent. Include paths are relative to that narrower root: use `**/*.md`, not
`messages/**/*.md`. A filter does not narrow a datastore's root boundary.

For a fresh direct-only setup with the default project-root projection, a
complete `.pi/markdown-datastore/config.json` is:

```json
{
  "schemaVersion": 1,
  "defaults": {
    "maxResultBytes": 12288,
    "maxResultLines": 300,
    "operationTimeoutMs": 10000
  },
  "qmd": {
    "enabled": false,
    "installation": { "executable": "qmd" },
    "minimumVersion": "2.8.3"
  },
  "stores": {
    "telegram": {
      "root": "messages",
      "include": ["**/*.md"],
      "exclude": [],
      "maxFileBytes": 1048576,
      "search": { "defaultMode": "lexical", "qmdCollection": "telegram" }
    }
  }
}
```

Create the `messages/` directory first; keep the config directory mode 0700 and
file mode 0600. With a custom projection root, use the absolute path to its
`messages/` directory instead. Do not change `markdownProjection.root` to the
message directory: the projector appends `messages/` itself. The group store
continues to use its dedicated shared archive root with `**/*.md`.

The example enables direct find/read only. Recall additionally needs the
supported qmd setup and derived indexes described by the datastore package.
Its optional qmd collection belongs to the project-local datastore generation;
qmd/model setup remains opt-in.
Telegram auto mode discovers only that configured name. Off mode disables all
integration. Required mode provides a persistent error and immediate recall
failure if the service is missing/incompatible/unready or advertises another
store. Timeline, archiving and transport continue. Private assembly should enforce
required mode through the factory override rather than changing live settings.

Observability is optional: valid persisted tool-intent records enrich activity,
otherwise basic tool-name activity works. This package does not discover private
credentials or install observability automatically.

### Narrowing an existing private datastore root

Keep message files, media, projection metadata, source sessions, and transport
journals in place. In the existing datastore config, change only the private
store's `root` to the projection parent's `messages/` directory and its `include`
to `["**/*.md"]`; preserve its other settings. This is not an archive migration.

Activating the changed configuration requires the separately authorized resource
reload/restart for the affected runtime. Afterwards, use the datastore's public
refresh operation for the affected store to regenerate lexical derived state;
request semantic refresh when semantic/hybrid recall is used. Check public
status/readiness and exact-path find/read before trusting recall. Do not edit
backend databases, copy index files, or rewrite journals to make the old index
appear current.

Datastore paths and URIs now start at `messages/`: for example,
`messages/2026/01/note.md` becomes `2026/01/note.md` in the `telegram` store.
Re-find stored retrieval references against the narrowed store rather than
relabeling backend records. Telegram timeline and attachment-provenance paths
remain projection-relative, including `messages/_attachments/...`; do not prepend
the narrowed datastore root to those provenance paths. Embedded attachment and
predecessor wikilinks retain their names and filesystem targets because no
source files move.

## Queue endpoint

Set `"queuePort"` in config.json to a free local port (1024–65535) to accept
local work on `127.0.0.1`. Automation running under the same account can then
queue an owner-authority instruction:

```bash
curl -s -X POST http://127.0.0.1:7351/queue -H 'Content-Type: application/json' \
  -d '{"kind":"instruction","source":"nightly-calendar","id":"2026-01-01-alarm","reply":"private","text":"Tell the owner tomorrow starts with an 8:00 meeting."}'
```

`reply` selects the private chat, the group or no reply. Use a stable `id` per
logical request so retries do not queue duplicates. `GET /status` returns
`state` (`idle` or `busy`), `queue` (`owner` and `peer` counts) and `group`
(`unconfigured`, `verifying`, `verified` or `unverified`). The endpoint never listens on other interfaces. A
group chat requires a queue port.

## Group chat

A group joins several agents, each with its own project, bot and private chat
with the same owner, in one Telegram supergroup with the owner. All of the
agents run on one host under one operating-system account: they reach each
other on `127.0.0.1` and share one directory.

1. Create the group in Telegram, add every agent bot, and promote each bot to
   administrator with permission to delete messages and ban users. Add nobody
   else. Telegram converts the group to a supergroup when needed.
2. Find the supergroup's ID: open the group in Telegram Web, and the address
   ends with it, for example `#-1001234567890`. Use that negative number.
3. In BotFather, disable "Allow Groups" for each bot after adding it, so it
   cannot be added elsewhere.
4. Create the shared root outside every agent's project, for example
   `mkdir -m 700 /absolute/path/to/group-chat`. Agents refuse a shared root
   that other accounts can read. Every agent names the same absolute path.
5. Give each agent a distinct `queuePort` and add a `groupChat` object to its
   config.json. Each agent lists every other agent, never itself, and the
   `queuePort` it lists for another agent must be that agent's own
   `queuePort`:

```json
{
  "ownerUserId": 10001,
  "privateChatId": 10001,
  "tokenEnv": "TELEGRAM_BOT_TOKEN",
  "agentLabel": "Agent A",
  "queuePort": 7351,
  "groupChat": {
    "chatId": -1001234567890,
    "sharedRoot": "/absolute/path/to/group-chat",
    "datastore": { "mode": "auto", "store": "telegram-group" },
    "electionStepMs": 2000,
    "otherAgents": [
      {
        "telegramAccount": "example_agent_b_bot",
        "telegramName": "Agent B",
        "botUserId": 200000002,
        "queuePort": 7352
      },
      {
        "telegramAccount": "example_agent_c_bot",
        "telegramName": "Agent C",
        "botUserId": 200000003,
        "queuePort": 7353
      }
    ]
  }
}
```

`chatId` is the negative supergroup ID. `telegramAccount` is the bot username
without `@` and `botUserId` its numeric ID (the digits before the colon in that
bot's token). `telegramName` is how the agent is named to the others.
`electionStepMs` (default 2000, 250–30000) is the delay between election ranks.
`datastore` uses the same modes as the private `datastore` setting and names
the store for the shared Markdown. The agent's own username and ID come from
Telegram at startup. Usernames, bot IDs and ports must be unique and must not
match the owner. An agent that lists its own bot stays unverified and says so.
All agents must describe the same group, owner, roster and election step;
election ranks depend on it, and agents that disagree pause the group until
the configuration is corrected and they are restarted.

For group recall, add a store to each agent's datastore configuration with the
same name as `groupChat.datastore.store`, rooted at the shared root:

```json
"telegram-group": {
  "root": "/absolute/path/to/group-chat",
  "include": ["**/*.md"],
  "search": { "defaultMode": "lexical", "qmdCollection": "telegram-group" }
}
```

After starting the agents, `/status` in the private chat reports group
verification. All group agents must support lifecycle protocol version 1. If
membership or protocol support does not match, the agent names the mismatch and
sends nothing to the group until it is fixed. Private transport remains usable. To check routing, mention one
agent in the group and confirm only that agent shows activity; then send an
unaddressed question and confirm exactly one agent claims it. Ask that agent to
consult a peer and verify its Request, the peer's correlated Reply, and the
original task's result. A normal acknowledgment must not start another request.
Peer tool calls require explicit semantics, for example:

```json
{"kind":"request","recipients":["@example_agent_b_bot"],"text":"Check the result."}
{"kind":"reply","requestId":"REQUEST_ID_FROM_ENVELOPE","text":"Result checked."}
{"kind":"notify","text":"For room context only; no acknowledgment needed."}
```

To restore group history, export the group from Telegram Desktop as HTML, then
prepare the import:

```bash
pi-telegram-group-import --export-root EXPORT
```

This writes two control files to `EXPORT-import` next to the export (or
`--control-dir`), leaving the export itself untouched. `source.json` pins every
export page and is complete. `group-speakers.json` lists every sender name found
in the export; replace each `<placeholder>` with the sender's `kind` (`owner`,
`agent` or `other`) and numeric Telegram `userId`:

```json
{
  "schema": "pi-telegram-owner/group-speaker-map/v1",
  "speakers": {
    "Example Owner": { "kind": "owner", "userId": 10001 },
    "Agent B": { "kind": "agent", "userId": 200000002 }
  }
}
```

Then run a dry run and review the counts:

```bash
pi-telegram-group-import --export-root EXPORT --chat-id -1001234567890 --shared-root /absolute/path/to/group-chat
```

Add `--commit` to write. The dry run and commit refuse to run while a
placeholder remains, and refuse if an export page changed after preparing.
Preparing again keeps filled-in senders and adds any new ones. Only messages
missing from the shared journal are added, so repeating an import changes
nothing. The importer takes the shared journal lock, so running agents need not
be stopped.

## CLIs

`pi-telegram-register-menu PROJECT_ROOT [--config-dir DIRECTORY]` reconciles the
five-command owner menu for private chats using protected config. This contacts Telegram. Tests
intercept fetch with a synthetic fixture; no test contacts the service.

### Private archive import

The workflow is **prepare, fill placeholders, dry-run, review counts, commit**.
No hand-computed hashes are needed. Export the private conversation from Telegram
Desktop as HTML and supply the Pi session input root:

```bash
pi-telegram-archive-import --prepare --export-root EXPORT --pi-session-root SESSIONS
```

Prepare writes mode-0600 controls in the mode-0700 sibling directory
`EXPORT-import` (or `--control-dir DIRECTORY`, outside the export). It leaves
export pages, media, Pi sessions, and transport journals untouched:

- `source.json` is complete: every `messages.html`, `messages2.html`, etc. page,
  in numeric order, with byte size, SHA-256, and the total non-service message count.
- `speakers.json` lists readable sender names with direction `<placeholder>`.
  Set each to `in` (owner) or `out` (agent). The map uses
  `pi-telegram-owner/speaker-map/v1`, `revision: 1`, and
  `keyEncoding: "display-name"`; keep the encoding field so even a name that
  looks like a hash is unambiguous. No direction is guessed from a display name.
- `first-pi-boundary.json` contains a computed source-manifest hash, a
  reviewable `admittedPiSessionIds` list, and `firstPi: "<placeholder>"`.
- `boundary-candidates.json` lists fully computed candidate `firstPi` objects.
  Candidates are generated once all speaker directions are filled.

After filling directions, run the same `--prepare` command again. It preserves
filled speaker entries, their revision, the reviewed session list, and any
selected boundary. Review `admittedPiSessionIds`: the initial list comes only
from the selected input files. Repeated `--pi-session RELATIVE_PATH` selects
specific files under SESSIONS; otherwise discovery selects its top-level JSONL
files. Supply only the intended conversation's session input set. Remove
unwanted IDs from the admitted list; they stay excluded on re-prepare. Admission
still requires a nonempty unique list including the anchor session, with exactly
one selected source file per admitted ID and unambiguous session ordering.

Choose the candidate identifying the first Pi-backed message in this export.
Copy that **complete object** from the `candidates` array into `firstPi` in
`first-pi-boundary.json`, replacing the placeholder. Candidates require exact
Markdown-semantic or raw-source-text agreement and the assigned direction; the
importer does not select one automatically. Multiple candidates remain an
operator decision. If none are found, check the export, selected sessions, and
speaker directions; prepare reports this explicitly rather than guessing.

Run a dry-run, then review its historical, Pi-aligned, unresolved, ambiguous,
missing-coverage, chunk-candidate, and gap counts before committing:

```bash
pi-telegram-archive-import --export-root EXPORT --pi-session-root SESSIONS --dry-run
pi-telegram-archive-import --export-root EXPORT --pi-session-root SESSIONS --commit --output-root ARCHIVE
```

Use the same session selection and journal for preparation and subsequent runs.
Use the same alignment options for dry-run and commit. These two modes read
controls from the same default directory (or `--control-dir`) and refuse any
`<placeholder>`, naming
the file and entry. Dry-run writes `checkpoint.json` there, binding the exact
inputs and plan. Commit refuses changed pinned export pages or an unmatched
checkpoint. After intentionally changing inputs, prepare again if needed and
review a new dry-run; never edit hashes or checkpoints to bypass that check.

`pi-telegram-archive-import` accepts named arguments only:

- Required: --export-root and --pi-session-root.
- Controls: --control-dir; --source-set-manifest, --first-pi-anchor, --speaker-map,
  and --checkpoint override individual default paths for dry-run/commit.
  Prepare writes the standard filenames and accepts --control-dir instead of
  individual path overrides.
- Optional: --pi-session-root-id (default pi-sessions), repeated --pi-session,
  --journal, and --output-root. A supplied transport journal provides existing
  correlation evidence; it is never modified.
- Bounds: --lookahead (12), --chunk-candidate-gap-ms (2000),
  --chunk-candidate-min-length (3500), --deadline-seconds (60); positive integers.
- Repeated --html-pi-timestamp-offset-seconds accepts signed integers within
  plus or minus 86400.
- --dry-run is default. --commit requires --output-root and an exact matching
  checkpoint from dry-run. --prepare, --dry-run, and --commit are mutually exclusive.

Existing strict v1 boundary/source controls and hashed-key v1 speaker maps
(without `keyEncoding`) still work with their explicit path options; their
checkpoint binding is unchanged. Readable maps are normalized internally for
matching, while checkpoints bind the original control bytes. To generate new
controls from an existing export, use the prepare workflow in a new control
directory and review a fresh dry-run. The single
`pi-telegram-owner/first-pi-boundary/v1` contract retains its explicit session
list and `firstPi.matchKind` (`markdown-semantic` or `raw-source-text`). Use
synthetic fixtures in tests; do not commit personal exports or mappings.

All archive/control schemas use `pi-telegram-owner/<kind>/v1`: `source-set`,
`first-pi-boundary`, `speaker-map`, `import-report`, `import-checkpoint`,
`archive-manifest`, `media-event`, `message`, `private-import-prepare`, and
`boundary-candidates`; for the shared group root, `group-event` (journal entries),
`group-message` (notes), `group-speaker-map`, `group-import-prepare`, and
`group-import-report`. Earlier names and boundary shapes have no aliases in this unpublished package. Existing Telegram Desktop
HTML and media exports can be reused. Regenerate the source manifest, speaker
map and explicit boundary, then create a fresh dry-run checkpoint and publish
to a fresh output directory. Keep the existing archive available for verification.
Do not relabel old checkpoints or rewrite existing notes in place: their hashes
bind the original metadata and plan. Preserve original Pi sessions and transport
journals. These development changes do not migrate or activate live state.

Importer output reports counts and publication results. Repeating an accepted
commit is idempotent; changed inputs require a new reviewed dry-run. Do not repair
errors by deleting journals, advancing cursors or rewriting source evidence.

## Troubleshooting and validation

Configuration absence performs no transport or state writes. Invalid protected
configuration disables transport with a diagnostic. CAPABILITY_UNAVAILABLE is a
service/store/readiness mismatch; TIMEOUT aborts an owned RPC; CANCELLED indicates
caller or lifecycle cancellation. No repeated refresh retries target an absent
integration. Archive corruption and unsafe source paths fail explicitly.

Run npm run check, npm test, npm run build and npm run test:package. The packed
check exercises installed native helpers, both CLIs and real Pi loading in
disposable homes/profiles. Separate composition uses explicit DATASTORE_TARBALL
and OBSERVABILITY_TARBALL with npm run test:integration. Select the existing patched
host with PI_CODING_AGENT_PACKAGE; no live host installation is changed.
