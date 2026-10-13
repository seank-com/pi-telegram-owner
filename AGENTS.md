# Telegram owner development

Use Bash and TypeScript with Node 24.14.1 or later. Run npm ci, npm run check,
npm test, npm run build, npm pack --dry-run and npm run test:package.
Default tests use synthetic Telegram responses and disposable protected projects.
Never call real Telegram or use live journals, profiles, archives or credentials.
Packed companion tests require explicit DATASTORE_TARBALL and OBSERVABILITY_TARBALL;
run npm run test:integration. Select another test host with PI_CODING_AGENT_PACKAGE.
Use the package-owned pi-telegram-owner/<kind>/v1 archive schemas without legacy
name aliases. Preserve authoritative source evidence, forward-only
journals/cursors, cancellation and lock recovery. Optional datastore absence must
never block transport/timeline or create refresh retry noise. Private assemblies
may enforce required integration by factory override. Keep protocol consumption
small; datastore/observability own their implementations. No pushes, publishing,
PRs, live activation or runtime/settings changes without owner authorization.

## Dependency boundaries

Integrate dependencies through their supported public APIs and CLI commands.
The CLI is an API; a small adapter may combine SDK calls and CLI invocations.
Leave dependency implementation and lifecycle management to the dependency
through its supported interfaces. Do not import private modules, access
internal objects, read or mutate private storage schemas, copy private
algorithms, or patch a dependency runtime to obtain behavior missing from
the public contract. An exported symbol alone does not
establish a supported public contract.

Verify required behavior against the supported interface and version using
disposable integration fixtures. If that interface cannot meet a requirement,
record the evidence and tradeoff in the issue and seek a design decision
instead of silently bypassing the boundary. Existing implementation choices
are open to revision through an approved design; preservation guidance is
not a mandate to retain private integrations.

## Documentation and history

Repository documentation describes the current product: its behavior,
interfaces, configuration, dependencies, and operational requirements.
Keep investigation narratives, decision history, rejected approaches, and
implementation progress in issues and commit messages. Do not add review
reports, handoff diaries, or historical design documents to the repository.
Document enduring contracts and rationale only where they help someone use
or maintain the current implementation.

Write about what the product does. When a feature or dependency is removed,
remove its obsolete documentation and references rather than replacing them
with statements that it is no longer supported. Do not inventory unrelated
technologies or absent features. State a limitation only when it affects a
current supported workflow or a concrete user decision; provide actionable
guidance. Put any necessary transition instructions for shipped behavior in
release or migration notes, not permanent descriptions of the product.

Before finishing documentation changes, read them from a new user's
perspective: each statement should explain the current product without
requiring knowledge of the discussion or the previous implementation.
