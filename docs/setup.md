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

## CLIs

`pi-telegram-register-menu PROJECT_ROOT [--config-dir DIRECTORY]` reconciles the
five-command owner menu using protected config. This contacts Telegram. Tests
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
`archive-manifest`, `media-event`, and `message`. Earlier names and boundary
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
