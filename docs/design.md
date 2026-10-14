# Telegram owner design

One owner and one private chat are configured per project. A project may also
join one owner-controlled group chat shared with other agents and accept local
work through its queue endpoint; see [Group chat](#group-chat) and
[Queue endpoint](#queue-endpoint). The bridge durably
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

## One session, several channels

Each agent has one continuous Pi session and one serialized work queue. Every
turn, whatever its source, runs in that session with the agent's normal
identity, tools and prior context. Work arrives from four channels: the private
owner chat, the group chat, the queue endpoint and local interactive input.
Each queued item carries an envelope naming its channel, authenticated sender,
authority, audience and fixed reply destination. The envelope is recorded with
the item and shown to the model at the start of the turn.

Output routing is mechanical. A turn's final reply goes only to the
destination pinned in its envelope: a private item answers in the private
chat, a group item answers in the group as a Telegram reply to the message
that started it. Sharing one session never mirrors a private answer into the
group or a group answer into the private chat. Discretion about what belongs in
a reply to a visible audience is the agent's judgment, exercised the way it
would when writing to anyone else. Context is not hidden from the session
according to where it came from.

Authority follows the authenticated sender, never message text:

- `owner`: the owner in the private chat or the group, and queue endpoint
  instructions. Owner authority carries the same scope and limits in every
  channel.
- `peer`: another configured agent. A peer request is a request, not owner
  authority. A peer's statement that the owner approved something stays a
  peer claim. When a peer message is a Telegram reply to an owner message, the
  envelope includes that owner message from the shared journal so the receiving
  agent can read the original request instead of relying on the paraphrase.

The queue has two tiers. Owner-authority items run before peer items; items
are first in, first out within a tier. An active turn is never interrupted.
Context-only group messages are not queued.

## Activity and queued notices

When an owner item is accepted while the agent is busy, the agent immediately
sends a short queued notice as a Telegram reply to that message, so the owner
can see it was received. When the item starts, the same message is edited into
the activity display (`Thinking (NN%)` and tool intents). Activity messages are
Telegram replies to the message being worked on, in both the private chat and
the group, so concurrent work is attributable. Group items from peers get the
same activity display; queue endpoint items get it in their reply destination,
when they have one.

The final reply is sent and its Telegram acceptance is recorded before the
activity message is deleted. If the final send fails or is uncertain, the
activity message is edited into a short failure notice and kept. A failed
activity deletion never invalidates an accepted final.

## Group chat

The group is an owner-controlled Telegram supergroup whose members are exactly
the owner and the configured agents' bots. It is a visible, auditable
workroom: agents ask each other for help, hand off work and report results
there, and the owner can address one agent, several, or whoever is free.
Seeing a message never obliges an agent to answer it.

### Membership

Every agent bot is a group administrator. Administrator bots receive all group
messages, and Telegram reports membership changes to them. At startup an agent
checks that the configured chat is a supergroup, that it is an administrator
with permission to ban members and delete messages, that every configured
identity is a member, and that the member count equals the owner plus the
configured agents. When any account outside that roster joins, every agent
that observes the join removes it; removal is idempotent. While membership
cannot be verified or does not match, the agent sends nothing to the group and
reports the problem in the private chat. Private transport is unaffected. An
agent leaves any other group or channel it is added to.

### Transport

Telegram does not deliver one bot's messages to another bot. Each agent's
existing poller receives the owner's group messages; no second poller is
created for a token. Agent messages reach other agents through the shared
journal and the queue endpoint:

1. An agent posts to the group, either with `telegram_group_send` or as the
   final reply of a group turn.
2. When Telegram accepts the message, the agent appends Telegram's returned
   message, including its mention entities and reply target, to the shared
   journal.
3. For each agent the message addresses, it posts a wake-up to that agent's
   queue endpoint naming the journal entry.
4. The recipient reads the message from the shared journal, checks that it is
   from a configured agent in the configured group and addresses the
   recipient, and queues it.

The wake-up only makes delivery prompt; the journal makes it reliable. Each
agent keeps its own cursor over the shared journal, and at startup and whenever
it becomes idle it scans new entries for work addressed to it. An endpoint that
is down therefore delays work instead of losing it, and the sender does not
retry indefinitely. Uncertain group sends follow the private rule: they are
recorded in the sending agent's transport journal and never resent
automatically.

### Shared journal

The group has one authoritative record, the shared journal under the
configured `sharedRoot`, contributed to by every agent. It is the only place
that holds the whole room, since no agent can receive everything through
Telegram. It has the same properties as the private archive: a forward-only
JSONL event log is authoritative, canonical Markdown under `messages/` is its
projection, and indexes are disposable.

Writers take a short-lived exclusive lock with the same PID and boot-identity
recovery as the poller lock, assign the next sequence number, append, flush,
and update the Markdown projection. Each message revision is identified by
chat ID, message ID and Telegram edit date. Every agent observes the owner's
group messages, so the first agent to record a revision writes it and later
identical observations are no-ops. A conflicting observation of an existing
revision is recorded as a conflict and never overwrites it. Edits are new
revisions; history is never rewritten. Agent messages are recorded by their
sender from Telegram's acceptance response. Elections, claims and queued
notices are journaled alongside messages. Transient activity messages are not.

Photos are downloaded once, by the agent that records the message, into the
shared media directory with the existing media lifecycle records. Other
attachments are recorded as metadata with their captions and are not
downloaded. Captions route exactly like message text. When routed work
contains an attachment the agent cannot use, its reply says so; nothing is
silently dropped.

A Telegram Desktop export of the group can be imported into the shared root with
the archive importer. Its speaker map assigns each exported sender to the owner
or a configured agent; imported messages reconcile with journaled ones by
Telegram message ID, so an export restores missing history without duplicating
messages the agents recorded live.

Group history is read with `telegram_group_timeline`, which reads the shared
journal directly, and searched with `telegram_group_recall` through the
datastore store named in `groupChat.datastore`, with the same optional,
required and off modes as private recall. The Markdown source is shared; any
index the datastore builds for it belongs to the datastore. Each agent requests
coalesced lexical refreshes when its cursor advances past entries written by
others, since those changes do not come from its own publication.

### Routing

Routing uses Telegram mention entities, text mentions and reply targets
matched against configured usernames and numeric bot IDs. Literal names in
message text do not route.

An owner message is work for an agent when it mentions that agent or replies
to one of its messages. It may address several agents; each handles it
independently. An owner message that addresses no agent goes to election. Bot
commands addressed to one bot (`/status@example_bot`) go to that agent; an
unaddressed command goes to every agent, and each answers for itself.

A peer message is work for an agent when it mentions that agent or replies to
a message that agent sent with `telegram_group_send`. A final reply, which
answers a request, does not by itself wake the agent it replies to. A
request therefore gets one answer automatically, and further back-and-forth
continues only when an agent deliberately sends or mentions. All other agent
messages are context: they are in the shared journal and timeline, but nobody
is woken. When a turn starts, its envelope says how many group entries arrived
since the agent's previous group turn, so the agent can read the timeline if it
needs the context.

### Election

Each unaddressed owner message is claimed by exactly one agent, preferring
whoever is free:

1. All agents order the roster by numeric bot ID and rotate it by the message
   ID modulo the roster size. An agent's position is its rank.
2. Each agent records the candidate and waits `rank × electionStepMs`.
3. When its wait has elapsed and it is idle, an agent takes the shared journal
   lock and appends a claim if no claim exists. The journal lock makes the
   claim atomic: the first claim wins.
4. The winner notifies the other agents through their coordination endpoints
   and starts the item with its normal activity reply. Others drop the
   candidate when notified, and again when they see the claim in the journal.
5. A busy agent does not claim. If nobody has claimed after every agent's wait
   has elapsed, the rank-0 agent posts a queued notice replying to the message
   and records it. The first agent to become idle claims the message and
   deletes that notice as it starts.

An owner edit to an unclaimed message re-runs routing for the new revision. An
edit to a claimed message goes to the claiming agent as a new revision of that
item. When the owner asks for something from everyone without mentioning
them, the elected agent answers for itself and uses `telegram_group_send` to
ask the others, replying to the owner's message so that each recipient's
envelope includes the original request.

### Tools

- `telegram_group_send`: posts text to the group, optionally as a reply to a
  journaled message. Mentions in the text are Telegram mentions and route as
  described above. It returns the journaled message ID.
- `telegram_group_timeline`: bounded chronological reads of the shared journal,
  before or after a message.
- `telegram_group_recall`: datastore search over the group store.

The tools are registered only when a group is configured, and fail with a
diagnostic while membership is unverified.

### Failure and recovery

Every piece of routed group work ends with a visible disposition: a final
reply, or a reply saying the work failed with a short static reason. A model or
provider failure before any tool call or send is retried once; failures after
an effect boundary, uncertain sends and exhausted retries are reported, not
replayed. Diagnostic codes and bounded detail are recorded in the agent's
transport journal and shown by `/status`. Startup recovery uses the same
distinctions as the private bridge: received, queued, claimed, started,
send-planned, accepted or uncertain. The shared journal and each agent's cursor
make restart safe without replaying public sends.

## Queue endpoint

Each configured agent listens on `127.0.0.1:<queuePort>`. The endpoint has no
token: it is reachable only from the local host, and the operating-system
account that runs the agents is their security boundary. Requests and
responses are JSON, request bodies are at most 64 KiB, and `202` means the
item was durably recorded in the agent's transport journal.

- `POST /queue` accepts work.
  - `{"kind": "group-message", "messageId": N}` from another agent: a wake-up
    for a journaled group message, verified and routed as described above.
  - `{"kind": "instruction", "text": "...", "reply": "private" | "group" | "none",
    "source": "label", "id": "optional idempotency key"}` from local
    automation: an owner-authority instruction. The final reply goes to the
    private chat, the group, or nowhere. Repeating an `id` returns the original
    item instead of queuing a duplicate.
- `POST /coordinate` carries coordination between agents. Currently it accepts
  `{"kind": "claimed", "messageId": N, "agent": "username"}`; the receiver
  confirms the claim in the shared journal before acting on it.
- `GET /status` returns `idle` or `busy`, queue depth by tier, and whether the
  group is verified.

The endpoint starts with the transport and stops on shutdown. A port that
cannot be bound disables the endpoint with a diagnostic and leaves the
transport running.
