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
launch mechanism. Deprecated tokenFile and archive configuration are retained
for migration compatibility; new configurations use tokenEnv and markdownProjection.
The extension validates one owner and private chat before accepting updates.

Projection defaults to the project root. An absolute markdownProjection.root and
sessionRoot may be supplied; rootId is a safe stable namespace identifier.
Optional roleSlugs defines user, assistant and command filenames. Projection may
be false; the mandatory media-event stream still records photo provenance.
Journal/lock paths remain project-local to the selected Telegram config directory.
Do not share another agent's journal, archive, session root or configured stores.
The group chat's shared root is the one deliberately shared location.

For retrieval, configure the independent datastore extension with the exact
selected store, pointing to this archive root and including messages/**/*.md.
Exclude archive metadata and binary media. Its optional qmd collection belongs
to the project-local datastore generation; qmd/model setup remains opt-in.
Telegram auto mode discovers only that configured name. Off mode disables all
integration. Required mode provides a persistent error and immediate recall
failure if the service is missing/incompatible/unready or advertises another
store. Timeline, archiving and transport continue. Private assembly should enforce
required mode through the factory override rather than changing live settings.

Observability is optional: valid persisted tool-intent records enrich activity,
otherwise basic tool-name activity works. This package does not discover private
credentials or install observability automatically.

## Queue endpoint

Set `"queuePort"` in config.json to a free local port (1024–65535) to accept
local work on `127.0.0.1`. Automation running under the same account can then
queue an owner-authority instruction:

```bash
curl -s -X POST http://127.0.0.1:7351/queue -H 'Content-Type: application/json' \
  -d '{"kind":"instruction","source":"nightly-calendar","id":"2026-01-01-alarm","reply":"private","text":"Tell the owner tomorrow starts with an 8:00 meeting."}'
```

`reply` selects the private chat, the group or no reply. Use a stable `id` per
logical request so retries do not queue duplicates. `GET /status` reports
whether the agent is idle. The endpoint never listens on other interfaces. A
group chat requires a queue port.

## Group chat

A group joins several agents, each with its own project, bot and private chat
with the same owner, in one Telegram supergroup with the owner.

1. Create the group in Telegram, add every agent bot, and promote each bot to
   administrator with permission to delete messages and ban users. Add nobody
   else. Telegram converts the group to a supergroup when needed; use the
   supergroup's ID.
2. In BotFather, disable "Allow Groups" for each bot after adding it, so it
   cannot be added elsewhere.
3. Choose a shared root directory owned by the agents' account, mode 0700, for
   example outside every agent's project. Every agent must name the same
   absolute path.
4. Give each agent a distinct `queuePort` and add a `groupChat` object to its
   config.json. Each agent lists every other agent, never itself:

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
match the owner or the running bot. All agents must describe the same roster;
election ranks depend on it.

For group recall, add a store to each agent's datastore configuration rooted at
`<sharedRoot>/messages` with the same name as `groupChat.datastore.store`,
including `**/*.md`. Exclude journal state and media as for the private archive.

After starting the agents, `/status` in the private chat reports group
verification. If membership does not match, the agent names the mismatch and
sends nothing to the group until it is fixed. To check routing, mention one
agent in the group and confirm only that agent shows activity; then send an
unaddressed question and confirm exactly one agent claims it.

An existing Telegram Desktop export of the group can be imported with
`pi-telegram-archive-import --output-root <sharedRoot>`, using a speaker map
that assigns each sender to the owner or a configured agent. The importer takes
the shared journal lock, so running agents need not be stopped.

## CLIs

`pi-telegram-register-menu PROJECT_ROOT [--config-dir DIRECTORY]` reconciles the
five-command owner menu for private chats using protected config. This contacts Telegram. Tests
intercept fetch with a synthetic fixture; no test contacts the service.

`pi-telegram-archive-import` accepts named arguments only:

- Required: --export-root, --source-set-manifest, --first-pi-anchor, --speaker-map,
  --pi-session-root and --checkpoint, each naming explicit local input/control paths.
- Optional: --pi-session-root-id (default pi-sessions), repeated --pi-session,
  --journal, and --output-root.
- Bounds: --lookahead (12), --chunk-candidate-gap-ms (2000),
  --chunk-candidate-min-length (3500), --deadline-seconds (60); positive integers.
- Repeated --html-pi-timestamp-offset-seconds accepts signed integers within ±86400.
- --dry-run is default. --commit requires --output-root and an exact matching
  checkpoint from dry-run. The two flags are mutually exclusive.

Source manifests pin page paths/sizes/hashes and message count. Speaker maps pin
speaker hashes to directions. Boundary manifests pin the first admitted Pi entry
and normalized/source hash. The single `pi-telegram-owner/first-pi-boundary/v1`
contract requires `admittedPiSessionIds` and `firstPi.matchKind` (either
`markdown-semantic` or `raw-source-text`). The session list must be nonempty,
unique, and include the anchor session; no sessions are implicitly admitted.
Use synthetic fixtures in tests; do not commit personal exports or mappings.

All archive/control schemas use `pi-telegram-owner/<kind>/v1`: `source-set`,
`first-pi-boundary`, `speaker-map`, `import-report`, `import-checkpoint`,
`archive-manifest`, `media-event`, `message`, and the shared group journal's
`group-event`. Earlier names and boundary
shapes have no aliases in this unpublished package. Existing Telegram Desktop
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
