# Telegram owner design

One owner and one private chat are configured per project. A project may also
join one owner-controlled group chat shared with other agents and accept local
work through its queue endpoint; see [Group chat](#group-chat) and
[Queue endpoint](#queue-endpoint). The bridge durably
classifies every update before advancing its cursor, serializes work and records
outcomes in its forward-only JSONL journal. Restart recovery reconciles accepted
input, dispatched jobs, replies, commands, photos and transient activity without
resending uncertain outcomes. Source evidence is retained. Work lifecycle
transitions append records without rewriting messages, journal history or cursors.

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

Activity consumes only structurally valid versioned persisted audit data for
the matching call ID. Validation checks entry kind/version, field types and the
nonempty 1,000-character intent contract; it does not filter or normalize content.
pi-observability owns creation-time exact credential-value redaction. Telegram
trusts that persisted text without credential-shape guesses, punctuation/path/URL
bans, or another redaction pass against a potentially rotated registry.

Intents are displayed unchanged in full. Activity sends/edits use plain text
without parse_mode; JSON.stringify handles transport escaping, so apostrophes,
quotes, Markdown and redaction markers are ordinary text. Missing or malformed
audit evidence falls back to the established bounded tool name, never raw tool
arguments. Persisted identifiers/types are checked against the owner's actual
packed contract.

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
semantics. Group work lifecycle metadata is separate from archive/importer schema
identity; adding lifecycle records never rewrites source evidence or cursors.
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

Output routing is mechanical. A task's terminal reply goes only to the
destination pinned in its envelope: a private item answers in the private
chat, a group request answers its requester in the group. A model turn is not
itself a task completion: a task can wait for delegated work across several
turns, and an informational turn can finish without a reply. Only a durable
waiting task restores an earlier destination when a dependency returns. Sharing one session never mirrors a private answer into the
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
Context-only group messages are not queued. Waiting tasks do not occupy the
execution slot or prevent other queued work from running. A resumed task keeps
its original authority and destination; the peer supplying a dependency result
does not acquire the authority of the waiting task.

An agent is idle when no turn is running, nothing is queued, and no owner
message is being collected in the quiet window. Idle is the condition for
claiming group work in an election. An agent reserves its queue before it
claims, so nothing else can start between the claim and the turn.

## Activity and queued notices

When an item is accepted while the agent is busy, the agent immediately sends
a short queued notice in that agent's private owner chat. When the item starts,
the same private message is edited into the activity display (`Thinking (NN%)`
and tool intents). This private-only destination also applies to work whose
final reply goes to the group, and to queue endpoint work with a reply target.
Items with no reply target do not create activity. Typing remains private.

Private-chat work can anchor activity to its private input. Group message IDs
are never used as reply anchors in the private chat. Group work is labeled
"Group chat", or names the peer request with a line such as "RE: Agent B: Can
you check…". Actual Request/Reply/Notify messages and terminal answers retain
their intended destinations; only ephemeral status is private. Queued notices
and activity are transient: they are not recorded in either archive and never
wake another agent.

Activity receipts include their destination, so cleanup does not confuse equal
message IDs in different chats. Retained unscoped activity receipts resolve to
the original reply-target chat. Recovery cleans those historical messages in
that chat rather than editing or deleting a same-numbered private message.

A terminal reply is sent and its Telegram acceptance is recorded before the
activity message is deleted. If that send fails or is uncertain, the activity
message is edited into a short failure notice and kept. A failed activity
deletion never invalidates an accepted terminal reply. When a task enters
waiting, or an informational turn ends without text, activity is removed after
the corresponding local disposition is durable. Neither needs a placeholder
answer or an acknowledgment. Interrupted execution also removes its stopped
activity after the interruption is durable; any pinned failure notice remains
pending for delivery. A blocked or failed request still requires a visible
terminal disposition.

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

Projection validates persisted Pi text against its journal identity. Historical
work items without lifecycle metadata may use the exact pre-lifecycle envelope
without a Task header. The historical envelope is reconstructed from logical
fields, preserving multiline sender/context values; task bodies and the rest of
the envelope still match exactly. This compatibility does not rewrite canonical session entries or relax
validation for arbitrary changed content.

Interruption notices and canonical bridge-rendered turn-failure notices are
transport-generated local responses, not the model's partial or empty assistant
entry. A `task_output` lifecycle receipt between `interrupted`/`turn_failed` and
`reply_ready` does not change that provenance. A failure notice must exactly match
the bridge's renderer for the preceding failure code. Lifecycle metadata alone,
a failure/interruption after the reply, or evidence before a later dispatch does
not exempt a changed Pi answer from validation.

Normal session-start and delivery-maintenance reconciliation can recover a
projection backlog from the supplied persisted session and transport journal.
Replaying reconciliation preserves existing notes and source history, appends
projection receipts, and is idempotent. Index refresh follows newly projected
notes; rebuilding an index cannot replace missing projection. Preserve source
sessions, journals and archive manifests during repair: do not delete records,
edit old prompts, reset the conversation, or clear queues to bypass an error.

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
   journal with its threading and work metadata, and records pending wake-ups
   for its semantic recipients. Request obligations are established separately
   from transport delivery.
3. It posts each wake-up to that agent's queue endpoint, naming the journal
   entry, and retries with backoff until the recipient answers `202`. Pending
   wake-ups survive the sender's restart. A recipient that is down receives
   its work when it returns.
4. The recipient reads the message from the shared journal, checks that it is
   from a configured agent in the configured group and addresses the
   recipient, and durably records its admission or context-only disposition
   before answering `202`. This acknowledges delivery, not task completion.

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

Owner routing matches Telegram mention entities and reply targets against
configured usernames and numeric bot IDs. Names without `@`, such as an agent's
display name, do not route. Agent posts use their explicit work kind and
recipient metadata instead: quoted text, mentions in prose and Telegram
threading never create or close an obligation.

Consecutive owner messages within the quiet window are one item, as in the
private chat, so a long message Telegram split into parts routes once. The
item routes by the mentions and reply target of all its messages. An owner
item is work for every agent it mentions or whose message it answers. Each
handles it independently. An owner item that addresses no agent goes to election.

A peer Request queues work only for its recorded recipients. A Reply goes only
to the recorded requester; it resumes a matching waiting task or starts an
informational turn if no such task is waiting. A Notify queues an informational
turn only for its explicit recipients. A Notify without recipients is context
for the room and wakes nobody. A threading target never adds a recipient.

Every turn's envelope identifies whether it carries a request obligation, a
dependency result or information only. It includes the request/chain identity,
relevant terminal dispositions and pending dependencies, and the original task
context needed for a resumption. Private origin text and destination stay in the
requester's local journal, not in peer-visible work metadata. The envelope also
reports group entries since the previous group turn, so the agent can retrieve
more with `telegram_group_timeline` or `telegram_timeline`.

### Request, Reply and Notify

`telegram_group_send` has an object-root parameter schema with explicitly
object-typed conditional branches. Kind-specific required and forbidden fields
remain enforced; provider compatibility does not relax recipient routing or
request/reply correlation.

Group work uses three explicit kinds:

| Kind | Effect |
| --- | --- |
| Request | Creates one terminal-reply obligation for each addressed recipient. |
| Reply | Supplies a terminal disposition for the replying recipient's obligation on the identified request. It creates no acknowledgment obligation. |
| Notify | Supplies information without creating or completing a request obligation. |

The sender records the kind and correlation metadata before sending. Each
Request has an opaque `requestId`, generated once and retained across recovery,
the authenticated requester, and a nonempty set of configured recipient bot IDs.
An obligation is identified by `(requestId, recipientBotId)`; one recipient's
Reply cannot close another's obligation. Group identity scopes all references.
The tool resolves explicit recipient accounts to configured bot IDs before
sending; unknown recipients and attempts to answer another agent's obligation
fail before publication. New Request bodies prepend any missing recipient
@mentions, preserving existing case-insensitive mentions and the supplied text.
Both the send plan and published group text include those mentions. Routing
still uses the explicit recipient metadata: additional names mentioned in prose
are not recipients. Replies and notifications do not gain automatic mentions.
Recovery of an already accepted historical send never republishes it just to
add a mention.

A Reply identifies its request and has one of four terminal dispositions:
`completed`, `failed`, `blocked`, or `cancelled`. The text supplies the result or
reason. Sender identity comes from the journal and verified roster, not a name
in the message. Reply correlation does not depend on a Telegram reply anchor.
A disposition becomes effective when the accepted post and its work metadata
are durably recorded; a send attempt or queue endpoint `202` is not completion.

A distinct later Reply to a completed obligation remains source evidence and
is delivered as an informational update, not a second completion or a request
to acknowledge. This preserves substantive late corrections. An explicit
addressed Notify can also carry a correction. Delivery retries of the same
message are idempotent and never become additional informational turns. Text
similarity, latest-message-wins rules and blanket first-reply suppression do
not decide lifecycle or discard messages.

`replyToMessageId` controls presentation and context only. Telegram does not let
one bot reply to another bot's message. Such posts use a quote of the first
line and the other agent's `@username`; the shared journal retains the logical
threading link. Neither a quote nor a successful Telegram anchor changes kind,
recipients or request correlation.

### Tasks, delegation and completion

A task has a stable local identity, authenticated authority, pinned destination
and durable state separate from the current model turn: `executing`, `waiting`,
or `completed`. A queued task has not yet entered execution. Completed tasks
retain their outcome; receiving more context cannot make them waiting again.
Terminal disposition is separate from success: failed, blocked and cancelled
tasks are also completed.

A Request sent during an active task records a local dependency on that task.
The first Request in a delegation chain uses its `requestId` as `chainId`.
Requests made while handling that chain inherit its `chainId` and identify the
active group request as `parentRequestId`, when there is one. Private and queue
endpoint origins are linked only in the sender's transport journal. These
relationships survive compaction and restart and are not inferred from prose
or the Telegram threading target. A Request sent without an active task has
no local parent; its results are informational rather than owner-task resumptions.
Sending a Request after the active task's terminal Reply starts independent work;
it does not attach a new dependency to or reopen the completed task.

When a turn has accepted child Requests but has not supplied a terminal result,
its task enters `waiting` and releases the execution slot. A normal final text
at this boundary is progress, not completion: for a peer task it is an
unaddressed Notify, and for an owner task it goes only to the pinned owner
destination. A normal empty final at this boundary is allowed. The bridge does
not invent repeated waiting acknowledgments. Posting Notify alone does not
satisfy an unanswered Request or put it into waiting.

Each durably admitted child Reply updates only that child's recipient
obligation and makes its result pending for the parent. If the parent is still
executing, that result waits for a continuation after the turn; it cannot be
missed in the transition to waiting or cause concurrent execution. Several
replies arriving before that continuation runs share the pending continuation;
none of their evidence is lost. Receipt alone does not mean the parent has
consumed a result: it remains unfinished until presented in a continuation.
A running turn is never interrupted. A continuation
can wait again for remaining dependencies, or return the parent's terminal
result. A normal final text with no pending dependencies or unconsumed results
completes the active
task; for a peer Request the bridge publishes a correlated `completed` Reply.
An explicit Reply through the tool can complete that recipient's active task
earlier, even when children remain pending. Its accepted terminal disposition
suppresses a redundant automatic final only for the task whose obligation it
completed, not a different task active in the same turn. Later child results are
informational and cannot reopen it.

A child Reply is not copied automatically to the parent's audience. The
requester evaluates it and decides what belongs in the parent result. A
private owner consultation therefore returns to the original private task,
not to the group, only while that task is waiting. Resuming a peer task likewise
retains its original requester and obligation. Receiving a Reply for a completed
parent never mechanically unwinds to an older origin.

An informational turn has no reply obligation and no restored parent
destination. It may finish normally without text or an acknowledgment; this
is not a model-produced-no-reply failure. Optional normal final text is an
unaddressed Notify in the group, so it does not wake the sender merely because
it answers or mentions them. Asking someone to act requires a new explicit
Request. Supplying an update to a particular agent requires an addressed Notify.

### Dependency scheduling and blocked work

An outstanding obligation is not a lock on the agent. Owner/peer priority and
FIFO ordering remain unchanged, and only one model turn executes at a time.
A waiting task does not prevent admission or execution of another Request,
including dependency work in its own chain. A -> B -> C -> A can therefore
progress when C needs an independent fact or action from A. Chain membership
alone is neither permission for concurrent turns nor a reason to reject work.

A logical result dependency is different: if C's answer actually requires an
unfinished ancestor's result, scheduling cannot resolve it. The envelope makes
that dependency context available; the agent returns a `blocked` Reply naming
the unresolved dependency for requester/owner coordination. It does not silently
wait for a result that requires its own answer. No timeout, extra model worker
or unrestricted reentrancy is used to conceal a circular dependency.

### Durable state and compatibility

Versioned work metadata on shared agent posts carries kind, request identity,
recipient identities, reply disposition and parent/chain identity as applicable.
The shared journal preserves the messages and terminal evidence. The local
transport journal records task state transitions, dependencies, admission,
continuation scheduling and dispositions. Task completion and replay decisions
come from durable records, not the presence of an active Pi turn.

Readers retain support for historical request/answer posting records and records
without work metadata. A legacy request's chat/message identity provides a
stable namespaced request identity; a legacy answer correlates only through an
exact recorded request target and verified recipient identity. Historical
mentions are not reinterpreted with the new explicit-recipient rules. Imported
messages without authoritative live work metadata remain history, not newly
admitted Requests. Normalized lifecycle records append without editing source
messages or synthesizing a Telegram acceptance.

Only a recorded waiting task can resume. An older origin pointer without a
waiting transition is context, not evidence that a completed task should reopen.
A late answer can still arrive as information. Ambiguous or conflicting lifecycle
evidence is retained and diagnosed instead of guessed into new work.

Agents exchange group lifecycle protocol version 1 with their roster check.
Group sends remain disabled until compatibility is established, including while
peer negotiation is pending. Missing or incompatible support pauses group work with a diagnostic rather than
sending new work semantics to an incompatible agent. Private transport remains
available. Shared history is still readable without routing it through an older
work classifier.

`/new` cancels queued and waiting tasks from the private owner chat, group and
queue endpoint through durable explicit transitions. This includes a private
owner assignment waiting for a peer consultation. Each incoming Request
obligation gets a visible `cancelled` Reply; owner work keeps its pinned reset
disposition. Outbound dependencies are marked locally abandoned, not falsely
completed on behalf of remote recipients. This local abandonment does not claim
to cancel remote execution. Later dependency results remain recorded context and
do not wake or resume the reset task, including the pre-reset private assignment.
A new explicit Request or addressed Notify is still new work, not a stale delivery.

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
with `telegram_group_send` using `kind: "request"`, explicit recipients, and
threading to the owner's message. Each recipient's envelope then includes the
original request.

Election ranks depend on every agent having the same roster and
`electionStepMs` and a compatible group lifecycle protocol. Agents exchange a
roster check through their coordination endpoints whenever their membership
becomes verified. A mismatch pauses group
behavior on the agents that detect it and is reported in the private chat;
correct the configuration and restart the affected agents.

### Tools

- `telegram_group_send`: posts one explicit Request, Reply or Notify. `kind`
  and nonempty `text` are required; omitting kind is invalid rather than an
  implicit Request. Its input is a discriminated union:
  - Request: `{ kind: "request", text, recipients, replyToMessageId? }`.
    `recipients` is a nonempty array of configured peer `@username` accounts. The bridge
    captures the active local task and parent/chain relationship; callers do
    not supply or override another task's origin.
  - Reply: `{ kind: "reply", text, requestId, disposition?, replyToMessageId? }`.
    `disposition` defaults to `completed` and also accepts `failed`, `blocked`,
    or `cancelled`. Only the current agent's recorded recipient obligation is
    affected; recipients are determined by the request, not supplied here.
  - Notify: `{ kind: "notify", text, recipients?, replyToMessageId? }`.
    Omitted recipients means room context with no wake-up. An explicit recipient
    list delivers information without a terminal-reply obligation.
  Fields belonging to another kind are rejected. Recipient accounts resolve
  against the verified roster, not free-form mentions. Every result identifies
  its kind and journaled message ID; a Request also returns `requestId` and
  `chainId`, and a Reply returns its `requestId` and disposition. Results report
  publication/admission, not completion of work requested from another agent.
  Envelopes and timeline results expose correlation metadata for replying to a
  request other than the active one. A tool Reply closes its identified
  obligation, not every obligation on the active chain. Completing an older
  request A while handling request B does not discharge B or suppress B's
  empty-output or model-failure disposition.
- `telegram_group_timeline`: bounded chronological reads of the shared journal,
  before or after a message.
- `telegram_group_recall`: datastore search over the group store.

The tools are registered only when a group is configured. Timeline and send
fail with a diagnostic while membership is unverified; recall keeps searching
history. While membership is unverified, queued group items wait and private
work continues.

### Failure and recovery

Every Request obligation ends with a visible terminal disposition, or remains
explicitly waiting or delivery-uncertain. Owner and endpoint tasks keep their
own pinned destinations. A normal empty turn is valid after an accepted tool
Reply completes the active task's obligation, while waiting for that task's
accepted child Requests, or when processing information with no reply obligation.
None of these cases posts a model-failure notice. An unanswered Request with no
pending dependency cannot disappear silently: an empty turn in that case produces
a correlated `failed` Reply with a short static reason. Model errors, length-limit
stops and aborts are failures, not successful answers. If a tool Reply already
completed an obligation, a later model failure does not send another terminal
reply for that completed obligation; it is diagnosed locally. Any different
active task still receives its own applicable failure disposition. In particular,
replying to older request A while handling request B does not excuse an empty
turn or model error on B. An explicit `blocked` Reply reports a dependency
problem, not a delivery retry.

Failures are not automatically retried as work. Existing transport retries
remain delivery retries of the same accepted message. Diagnostic codes and
detail are recorded locally and shown by `/status`; optional informational
output never creates a requirement to acknowledge a diagnostic.

Startup recovery reconciles received, queued, claimed, executing, waiting,
completed, send-planned, accepted and uncertain states from the forward-only
journals. Startup and delivery maintenance reconcile recorded terminal delivery
receipts into local task completion without sending again; a progress receipt
does not complete its waiting parent. An executing model turn interrupted by
restart is not replayed as though it never ran; it receives the existing interrupted-work disposition.
A waiting task, in contrast, remains resumable when a new dependency result
arrives. Recovery completes an accepted post's metadata and wake-ups without
sending Telegram text again, and never closes an obligation on an uncertain
send. An accepted tool Reply awaiting publication or local completion recovery
suppresses duplicate automatic output without declaring that recovery complete.
The task remains delivery-pending until its terminal metadata is reconciled. Duplicate admissions, terminal records and continuation scheduling are
idempotent by identity. No recovery step edits source history, clears queues,
reclassifies old acknowledgments as fresh Requests, or resends uncertain posts.

## Queue endpoint

Each configured agent listens on `127.0.0.1:<queuePort>`. The endpoint has no
token: it is reachable only from the local host, and the operating-system
account that runs the agents is their security boundary. Requests and
responses are JSON. `202` means delivery was durably admitted or recorded as
needing no work, such as a duplicate or a result for a locally abandoned
dependency. It never means a Request has completed. Senders retry delivery until
they receive it. Calls between agents have no deadline, so a slow agent is
waited for, and each peer is called on its own
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
  - `{"kind": "roster", "agent": "username", "roster": "fingerprint",
    "groupLifecycleVersion": 1}`: the fingerprint covers the group, owner,
    every agent's bot ID and the election step. The receiver answers with its
    own fingerprint, lifecycle version and whether both are compatible.
- `GET /status` returns `idle` or `busy`, queue depth by tier, and whether the
  group is verified. It also reports local task identities, execution/waiting
  state, pending request/recipient identities and terminal dispositions without
  including task text or private destination details. `idle` describes the
  execution queue, not the absence of waiting obligations.

The endpoint starts with the transport and stops on shutdown. A port that
cannot be bound disables the endpoint with a diagnostic and leaves the
transport running.
