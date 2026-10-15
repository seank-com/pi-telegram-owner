# pi-telegram-owner
A simple extension for Pi that allows and agent to chat with it's owner over Telegram

A standalone Pi extension for one verified Telegram owner in a private chat:
transport, commands, protected canonical Markdown archive, photos and chronological
`telegram_timeline`. Datastore and observability are optional integrations.

Build with Node 24.14.1+, `npm ci`, then `npm run build`. The manifest loads only
`dist/index.js`. Pi and TypeBox are host peers; the package does not install a
second Pi runtime. Stock Pi 0.87.1 and the explicitly tested existing patched
0.87.1 artifact are the acceptance targets; other versions are unverified.

Polling and archive writes require macOS or Linux with a readable system boot
identity. macOS uses `kern.boottime`; Linux requires `/proc/sys/kernel/random/boot_id`
and `/proc/stat`. If these are unavailable, lock acquisition fails closed. Make
these kernel interfaces available to the process before starting the transport
or committing an import.

Create `<project>/.pi/telegram-owner/config.json` manually in a mode-0700 directory,
with mode 0600, positive `ownerUserId`/`privateChatId`, and `tokenEnv` naming the
bot token environment variable. Never commit a token. Configuration absence
registers tools/commands but starts no poller and writes no state.
See [setup](docs/setup.md) for configuration and CLI arguments.

Optionally, an agent can share an owner-controlled Telegram group with other
agents. Every message in the room is recorded in one shared journal; agents
address each other with mentions, and an unaddressed owner message is claimed
by whichever agent is free. A local queue endpoint on `127.0.0.1` lets
automation running under the same account queue owner-authority instructions.
See [design](docs/design.md#group-chat) and [setup](docs/setup.md#group-chat).

The optional `datastore` object selects `mode: "auto"` (default), `"off"`, or
`"required"`, and an exact `store` (default `"telegram"`). Auto enables recall
and lexical refresh only when the active datastore advertises that store.
Off performs no discovery or RPC. Required keeps a bounded recall failure and
persistent diagnostic when unavailable while preserving transport and timeline.
A private wrapper may call `createTelegramOwnerExtension({datastore:{mode:
"required",store:"telegram"}})` and list only that wrapper in its Pi manifest.
No companion npm dependency or ambient namespace discovery is used.

Observability enriches activity from validated persisted v1 `tool-intent` entries.
Without them activity shows `Using <tool>…`; raw arguments are never used.

Three compiled CLIs are included:

```bash
pi-telegram-register-menu PROJECT_ROOT [--config-dir DIRECTORY]
pi-telegram-archive-import --export-root EXPORT --source-set-manifest SOURCE.json \
  --first-pi-anchor BOUNDARY.json --speaker-map SPEAKERS.json \
  --pi-session-root SESSIONS --checkpoint CHECKPOINT.json --dry-run
pi-telegram-group-import --export-root EXPORT
pi-telegram-group-import --export-root EXPORT --chat-id CHAT_ID --shared-root ROOT --dry-run
```

Menu registration contacts Telegram and is an explicit operator action. Archive
import defaults to dry-run; commit requires the matching checkpoint and explicit
`--commit --output-root ROOT`. Group import first prepares control files with
placeholders to fill in, then defaults to dry-run and adds only messages
missing from the shared journal with `--commit`. The CLIs run as
native Node programs without loading Pi. Pure helpers are exported as `/format`, `/markdown-projector` and `/importer`.

Validation commands: `npm run check`, `npm test`, `npm run build`,
`npm pack --dry-run`, `npm run test:package`. Run `npm run hooks:install` once per
clone to refuse commits and pushes that add any line of `~/.pii` (matched
case-insensitively) or any value of 8 or more characters from `~/.env`;
`npm run check:private -- --all` checks every tracked file. The setting
persists across branches but has no effect on a branch without `.githooks/`. Default tests need no companion or
real Telegram. Explicit composition checks use actual candidate tarballs:

```bash
DATASTORE_TARBALL=/path/to/datastore.tgz OBSERVABILITY_TARBALL=/path/to/observability.tgz \
  npm run test:integration
```

Public README/MIT history and extracted implementation attribution are preserved.
Only compiled code/declarations, generic docs, README, LICENSE and metadata ship.

Archive/control schemas use `pi-telegram-owner/<kind>/v1`. The boundary requires
an explicit session list and matching mode. This unpublished contract has no
legacy aliases; reuse existing Telegram exports with fresh import controls and
a separate output archive as described in [setup](docs/setup.md).
