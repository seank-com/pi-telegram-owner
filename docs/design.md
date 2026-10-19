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

The archive importer prepares protected controls outside the export, pinning all
pages and listing readable sender names. Operators fill directions, re-prepare,
and confirm a generated exact semantic/raw-text boundary candidate, with no
hand-computed hashes. Preparation preserves filled controls and reviewed session
admission; discovery is limited to the supplied session input set. Existing
hashed speaker controls remain supported through explicit paths. Dry-run and
commit refuse unresolved placeholders with file/entry diagnostics, then validate
source manifests, speaker maps, Pi boundary anchors and explicit admitted
sessions. Dry-run binds a content-free checkpoint
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
back to a bounded tool name. Validated intents are displayed in full up to the
1,000-character audit limit, without a separate activity-display truncation.
Raw tool arguments are never displayed. Persisted
identifiers/types are checked against the owner's actual packed contract.

Native CLIs/archive helpers import no Pi runtime values. The extension supplies
Pi's CONFIG_DIR_NAME; the menu CLI defaults to .pi with an explicit override.
Runtime dependencies are declared parsing libraries; TypeBox and Pi remain host
peers for extension loading. Compiled ESM/declarations and every executable CLI
shebang ship. No tests, private operational content or sibling source imports
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
identity, tools and prior context. Work arrives from the private owner chat,
the group chat and the queue endpoint. Each queued item carries an envelope
naming its channel, authenticated sender, authority, audience and fixed reply
destination. The envelope is recorded with the item and shown to the model at
the start of the turn. Local interactive input in the agent's terminal keeps
Pi's normal behavior: it is answered in the terminal and is not accepted while
a queued item is running. The extension cannot authenticate who typed it, so it
carries no envelope and no channel authority; the agent judges it as it would
without this extension.

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

An agent is idle when no turn is running, nothing is queued, and no owner
message is being collected in the quiet window. Idle is the condition for
claiming group work in an election. An agent reserves its queue before it
claims, so nothing else can start between the claim and the turn.

## Activity and queued notices

When an item is accepted while the agent is busy, the agent immediately sends
a short queued notice as a Telegram reply to the message that delivered it, so
the sender can see it was received. This applies to owner messages in the
private chat and the group, and to peer requests in the group, where the
owner can see the request arrived. When the item starts, the same message is
edited into the activity display (`Thinking (NN%)` and tool intents). Activity
messages are Telegram replies to the message being worked on, in both the
private chat and the group, so concurrent work is attributable. Work on another
agent's message cannot be a Telegram reply, so its queued notice and activity
start with a line naming it instead, such as "RE: Agent B: Can you check…". Queue endpoint
items show activity in their reply destination, when they have one. Queued
notices and activity are transient: they are not recorded in either archive
and never wake another agent.

The final reply is sent and its Telegram acceptance is recorded before the
activity message is deleted. If the final send fails or is uncertain, the
activity message is edited into a short failure notice and kept. A failed
activity deletion never invalidates an accepted final.

## Archives

Each archive records exactly one Telegram conversation, so either can be
rebuilt from a Telegram Desktop export of that conversation alone:

- The private archive (`messages/` under the configured projection root) holds
  the private chat between the owner and this agent. Every message the agent
  posts in the private chat is recorded there, including replies to queue
  endpoint instructions and answers returned from group consultations.
- The shared journal under `groupChat.sharedRoot` holds the group chat. Every
  message posted in the group by the owner or any agent is recorded there.

Queue endpoint instructions are recorded in the agent's transport journal.
They are not Telegram messages, so neither archive holds them. Turns started by
group or queue endpoint items carry their own session marker, and the private
projector treats them as turn boundaries, never as private-chat turns.

## Group chat

The group is an owner-controlled Telegram supergroup whose members are exactly
the owner and the configured agents' bots. It is a visible, auditable
workroom: agents ask each other for help, hand off work and report results
there, and the owner can address one agent, several, or whoever is free.
Seeing a message never obliges an agent to answer it. Bot commands work only
in the private chat. The command menu is registered for private chats, and
command text in the group is an ordinary message.

### Membership

Every agent bot is a group administrator. Administrator bots receive all group
messages, and Telegram reports membership changes to them. The poller requests
`message`, `chat_member` and `my_chat_member` updates. Edits are not requested:
each message is recorded and routed as first sent.

At startup, and on every membership update, an agent checks that its
configuration does not list its own bot among the other agents, that the shared
root is a directory owned by the agents' account with mode 0700, that the
configured chat is a supergroup, that it is an administrator with permission
to ban members and delete messages, that every configured identity is a
member, and that the member count equals the owner plus the configured agents.
When any account outside that roster joins, every agent that observes the join
removes it; removal is idempotent. While membership cannot be verified or does
not match, the agent sends nothing to the group, keeps group items queued, and
reports the problem in the private chat. Private transport is unaffected. An
agent leaves any other group or channel it is added to. A group message whose
sender is not the owner's user account, such as one posted anonymously as the
group, has no owner authority; it is recorded but not routed. Service messages
such as pins, joins and title changes are neither recorded nor routed.

### Transport

Telegram does not deliver one bot's messages to another bot. Each agent's
existing poller receives the owner's group messages; no second poller is
created for a token. Agent messages reach other agents through the shared
journal and the queue endpoint:

1. An agent posts to the group, either with `telegram_group_send` or as the
   final reply of a group turn. A message Telegram must split into several
   parts is recorded as one journal entry listing every part's message ID.
2. When Telegram accepts the message, the agent appends it to the shared
   journal with its reply target, and records a pending wake-up for each agent
   it addresses.
3. It posts each wake-up to that agent's queue endpoint, naming the journal
   entry, and retries with backoff until the recipient answers `202`. Pending
   wake-ups survive the sender's restart. A recipient that is down receives
   its work when it returns.
4. The recipient reads the message from the shared journal, checks that it is
   from a configured agent in the configured group and addresses the
   recipient, and durably queues it before answering `202`.

Uncertain group sends follow the private rule: they are recorded in the
sending agent's transport journal and never resent automatically. Startup
recovery of an accepted send completes its journal append and wake-ups.

When a message replies to another message, Telegram includes a copy of the
replied-to message in the update. An agent that receives an owner reply to a
message missing from the shared journal records the copy, so the owner can
repair a lost entry by replying to it and mentioning the agent that should act.

Group updates are recorded in the agent's transport journal before its cursor
advances, as private updates are. Publication to the shared journal is a
separate step retried from that record. A shared journal failure is reported
once in the private chat and retried; it never holds the private cursor or
private work. A shared journal lock that stays unreadable is reported with its
path instead of waited on, so an operator can check that no agent is writing
and remove it.

### Shared journal

The group has one authoritative record, the shared journal under the
configured `sharedRoot`, contributed to by every agent. It is the only place
that holds the whole room, since no agent can receive everything through
Telegram. It has the same properties as the private archive: a forward-only
JSONL event log is authoritative, canonical Markdown is its projection, and
indexes are disposable. The shared root is dedicated to the group, so notes
sit directly under it by month (`YYYY/MM/`), photos under `_attachments/`,
and the event log and lock under `.telegram-archive/`. The
private archive keeps the same layout under `messages/` beneath its projection
root. Its datastore root is that `messages/` directory itself, with root-relative
`**/*.md` includes, not the projection parent with a `messages/**/*.md` filter.
The projection root and the datastore boundary are distinct: narrowing the
latter changes retrieval-relative paths, not archive placement or source bytes.

Writers take an exclusive lock with the same PID and boot-identity recovery as
the poller lock, assign the next sequence number, append, flush, and update the
Markdown projection. A writer that finds an incomplete final line left by a
writer whose lock was recovered terminates it with a newline, so the fragment
is kept but ignored by readers. Messages are identified by chat ID and message
ID. Every agent observes the owner's group messages, so the first agent to
record a message writes it and later identical observations are no-ops. A
conflicting observation of an existing message is recorded as a conflict and
never overwrites it. Agent messages are recorded by their sender from
Telegram's acceptance response. When a message is first known only from
Telegram's copy inside a reply, its sender's own record later supersedes that
copy. Claims, election notices and roster mismatches are journaled alongside
messages; each agent keeps its own election candidates in its transport
journal.

Routing reads Telegram's entities against the untrimmed `text` or `caption`,
using Telegram's UTF-16 offsets. Photos are downloaded once, by the agent that
records the message, into the shared media directory with the existing media
lifecycle records. Other attachments are recorded as metadata with their
captions and are not downloaded. Captions route exactly like message text.
When routed work contains an attachment the agent cannot use, its reply says
so; nothing is silently dropped.

A Telegram Desktop export of the group can be imported into the shared root with
`pi-telegram-group-import`. A prepare pass pins the export pages and lists every
sender; the operator assigns each sender to the owner, an agent or another
person. Messages whose Telegram message ID is already journaled are left as recorded, so an export restores missing history without
duplicating or overwriting what the agents recorded live. Exported photos are
stored like live ones; other attachments are recorded as metadata.

Group history is read with `telegram_group_timeline`, which reads the shared
journal directly, and searched with `telegram_group_recall` through the
datastore store named in `groupChat.datastore`, with the same optional,
required and off modes as private recall. The Markdown source is shared; any
index the datastore builds for it belongs to the datastore. Each agent requests
coalesced lexical refreshes after each message it records or observes in the
shared journal, when the group store is available.

### Routing

Routing matches `@username` mentions, text mentions and reply targets against
configured usernames and numeric bot IDs. For the owner's messages it uses
Telegram's mention entities; for agent posts, which other bots never receive,
it finds `@username` in the text as Telegram does. Names without `@`, such as
an agent's display name, do not route.

Consecutive owner messages within the quiet window are one item, as in the
private chat, so a long message Telegram split into parts routes once. The
item routes by the mentions and reply target of all its messages.

An owner item is work for an agent when it mentions that agent or replies to
one of its messages. It may address several agents; each handles it
independently. An owner item that addresses no agent goes to election.

A peer request is work for an agent when it mentions that agent or replies to
a request that agent sent with `telegram_group_send`. A peer answer is work
only for the agent whose request it answers, even when it mentions others. All
other agent messages are context: they are in the shared journal and timeline, but nobody is woken.
When a turn starts, its envelope says how many group entries arrived since the
agent's previous group turn, so the agent can read the timeline if it needs the
context.

### Requests and answers

A message sent with `telegram_group_send` is a request. Any other message an
agent posts in the group is an answer. The journal records each request with
the work item that was active when it was sent: the origin.

Telegram does not let one bot reply to another bot's message. When an agent
answers or replies to another agent's message, it posts without a Telegram
reply: the message starts with a quote of the first line of the message it
answers, then the other agent's `@username`. The shared journal records the
reply link as usual, so routing is unaffected; the quote and mention are how
the owner sees the link in Telegram and in an export.

A request wakes the agents it addresses, and the final reply of the turn it
starts answers it. A reply to a request always wakes the agent that asked. That
answer turn runs with the origin's reply destination, not the group. If the
owner asked an agent something privately and that agent consulted a peer, the
peer's answer wakes the asking agent, and its final reply goes back to the
owner in the private chat. If the origin was itself a peer's request, the
final reply answers that peer, which wakes the peer in turn. Work is therefore
handed back up the chain until it reaches whoever started it.

The answer turn's envelope carries the request text, the origin's sender and
destination, and the journal or private-chat message IDs of both. The agent can
read more with `telegram_group_timeline` or `telegram_timeline`, so resuming
does not depend on what remains in the session after compaction or `/new`.

An answer never starts a new request. Two agents can keep a conversation going
only by deliberately sending requests, and each request is visible in the
group. A `telegram_group_send` that replies to the peer message the current turn is
answering, such as a clarifying question, is that turn's response: its final
reply is not posted, so the peer is not woken twice. A clarifying question sent
with `telegram_group_send` as a reply to a request is itself a request: it wakes the asker, whose reply answers the
question, and the original request is still answered by the turn it started. A
request made with no active work item, such as from local interactive input,
has no origin; its answer turn replies in the group. When an agent sends
several requests from one item, each answer wakes it separately, and each
answer turn replies to the origin, saying what is still outstanding when it is
not yet complete.

`/new` in the private chat ends the agent's queued group and queue endpoint
items. Each ended group item gets a reply saying the owner reset the agent's
session; that reply answers the item, so a requesting agent is woken and can
tell its own origin. Requests the agent was waiting on are closed. Their later
answers are recorded as context and wake nobody.

### Election

Each unaddressed owner item is claimed by exactly one agent, preferring
whoever is free:

1. All agents order the roster by numeric bot ID and rotate it by the item's
   first message ID modulo the roster size. An agent's position is its rank.
2. Each agent records the candidate and waits `rank × electionStepMs`.
3. When its wait has elapsed and it is idle, an agent reserves its queue,
   takes the shared journal lock and appends a claim if no claim exists. The
   journal lock makes the claim atomic: the first claim wins.
4. The winner notifies the other agents through their coordination endpoints
   and starts the item with its normal activity reply. Others drop the
   candidate when notified, and again when they see the claim in the journal.
5. A busy agent does not claim. If nobody has claimed once the last rank's
   wait has elapsed, the first agent to reach that point posts a queued notice
   replying to the message and records it, so one notice is posted even if
   some agents are down. The first agent to become idle claims the item and
   deletes that notice as it starts.

The elected agent's envelope says it was chosen because the message did not
@mention anyone, and that if the message asks for everyone or implies it, the
agent answers for itself and then asks the others, named by their usernames,
with `telegram_group_send` replying to the owner's message. Each recipient's
envelope then includes the original request.

Election ranks depend on every agent having the same roster and
`electionStepMs`. Agents exchange a roster check through their coordination
endpoints whenever their membership becomes verified. A mismatch pauses group
behavior on the agents that detect it and is reported in the private chat;
correct the configuration and restart the affected agents.

### Tools

- `telegram_group_send`: posts a request to the group, optionally as a reply
  to a journaled message. Mentions in the text are Telegram mentions and route
  as described above. The request records the active work item as its origin.
  It returns the journaled message ID.
- `telegram_group_timeline`: bounded chronological reads of the shared journal,
  before or after a message.
- `telegram_group_recall`: datastore search over the group store.

The tools are registered only when a group is configured. Timeline and send
fail with a diagnostic while membership is unverified; recall keeps searching
history. While membership is unverified, queued group items wait and private
work continues.

### Failure and recovery

Every piece of routed group work ends with a visible disposition: a final
reply, or a reply saying the work failed with a short static reason. The same
rule applies to private and queue endpoint work in their own destinations. A
final counts only when the model stopped normally with text; a model error, an
empty reply, or output cut off by a length limit or an abort is reported as a
failure, never posted as an answer. A turn that sent a group request and ended
without text is not a failure: the first such turn for a destination gets a
short note naming who was asked, later ones in the same exchange post nothing,
and the answer follows as a new turn. A reply that posted nothing is not
archived. Failures are not retried
automatically. The owner or requesting agent decides whether to ask again.
Diagnostic codes and detail are recorded in the agent's transport journal and
shown by `/status` in the private chat. Startup recovery uses the same
distinctions as the private bridge: received, queued, claimed, started,
send-planned, accepted or uncertain. Work that was started is not replayed.

## Queue endpoint

Each configured agent listens on `127.0.0.1:<queuePort>`. The endpoint has no
token: it is reachable only from the local host, and the operating-system
account that runs the agents is their security boundary. Requests and
responses are JSON. `202` means the item was durably recorded in the agent's
transport journal, or, for an answer to a request closed by `/new`, that it
needs no work; senders retry until they receive it. Calls between agents have
no deadline, so a slow agent is waited for, and each peer is called on its own
so a stalled one holds up nothing else. An agent whose endpoint refuses
connections, because it is not running or its port is wrong, is reported once in
the private chat while delivery keeps retrying.

- `POST /queue` accepts work.
  - `{"kind": "group-message", "messageId": N}` from another agent: a wake-up
    for a journaled group message, verified and routed as described above.
  - `{"kind": "instruction", "text": "...", "reply": "private" | "group" | "none",
    "source": "label", "id": "optional idempotency key"}` from local
    automation: an owner-authority instruction. The final reply goes to the
    private chat, the group, or nowhere. Repeating an `id` returns the original
    item instead of queuing a duplicate.
- `POST /coordinate` carries coordination between agents:
  - `{"kind": "claimed", "messageId": N, "agent": "username"}`: the receiver
    confirms the claim in the shared journal before acting on it.
  - `{"kind": "roster", "agent": "username", "roster": "fingerprint"}`: the
    fingerprint covers the group, owner, every agent's bot ID and the election
    step. The receiver answers with its own fingerprint and whether they match.
- `GET /status` returns `idle` or `busy`, queue depth by tier, and whether the
  group is verified.

The endpoint starts with the transport and stops on shutdown. A port that
cannot be bound disables the endpoint with a diagnostic and leaves the
transport running.
