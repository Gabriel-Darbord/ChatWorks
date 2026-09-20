**ChatWorks**

Accessibility Automation and Reliable Watch Execution

Engineering Specification

Consolidated from implementation experiments and live validation through 20 September 2026

**Status** Working specification. It records validated behavior, required invariants, unresolved limitations, and the consolidation architecture. "Validated" means observed in tests or live ChatGPT Desktop experiments; "Target" means the intended consolidated design.

# 1\. Purpose and Scope

ChatWorks automates interaction with ChatGPT Desktop on macOS through the Accessibility (AX) API. Its watch mode observes assistant messages, executes explicitly directed message parts through configured modules, and submits resulting output back to the same conversation. The system must remain useful despite an asynchronous web-based editor, AX eventual consistency, large-paste attachment conversion, process crashes, and future ChatGPT UI updates.

This specification focuses on the ChatGPT accessibility bridge, composer staging and submission, watch execution semantics, durable recovery, diagnostics, and compatibility strategy. Participant/discussion orchestration is relevant only where it constrains these mechanisms.

## 1.1 Primary goals

- Execute only explicitly directed assistant content (for example, a #!chatworks shell block).
- Observe ChatGPT passively: background watch polling must not steal application focus.
- Stage and submit results reliably without assuming synchronous editor updates.
- Avoid pointer movement for normal submission and restore the user's prior focus after a committed send.
- Prevent duplicate execution of arbitrary side effects across retries, AX failures, crashes, and restarts.
- Preserve enough durable state to recover completed output without re-executing its originating command.
- Expose generic diagnostics that characterize the current ChatGPT AX behavior rather than encoding one UI version's assumptions.

## 1.2 Non-goals

- Exactly-once semantics against arbitrary external side effects cannot be proven after an OS/process crash; uncertain execution is surfaced instead of guessed.
- ChatGPT sidebar index is not treated as durable conversation identity.
- No fixed text-size threshold is used to predict whether ChatGPT will create a Pasted text.txt attachment.
- AX action success codes are not treated as proof of semantic success.

# 2\. Core Invariants

| **ID** | **Invariant**                                                                                                                         |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| I1     | Read-only observation must not activate ChatGPT or change pointer/focus.                                                              |
| I2     | A user-message boundary is structural and is recorded even if composer state is transient.                                            |
| I3     | Assistant content executes only after a stable observation and only when the composer is ready.                                       |
| I4     | Before arbitrary execution begins, durable state is written as executing.                                                             |
| I5     | After execution returns a response, that exact response is durably written as pending before submission is attempted.                 |
| I6     | A submission exception is treated as potentially mutating; it is never retried automatically in the same process.                     |
| I7     | Recovered executing work is never re-executed automatically.                                                                          |
| I8     | Recovered pending output may be submitted without re-executing the originating command only when recovery is safely reconciled.       |
| I9     | Neither composer clearing nor conversation advancement alone proves submission. Submission requires correlated evidence that the staged composer representation was consumed and that a committed user turn follows the same assistant boundary.                                   |
| I10    | Paste/stage is asynchronous for all payload sizes. Attachment conversion is an additional asynchronous representation path.           |
| I11    | Normal sending must not rely on a physical pointer click.                                                                             |
| I12    | Any unresolved durable transaction blocks newer assistant-provided execution until reconciled or invalidated by a permitted boundary. |

# 3\. Architecture

The consolidated design separates observation, semantic assessment, actions, and orchestration. The AX bridge should expose raw facts and narrowly scoped actions; TypeScript orchestration should decide when those facts establish a safe transition.

ChatGPT Desktop  
↕ macOS AX / keyboard / pasteboard  
ChatWorksAX (Swift)  
• passive snapshots  
• explicit interaction primitives  
• structural message observation  
↕ JSON bridge  
ChatWorks core (TypeScript)  
• semantic assessments  
• watch state machine  
• durable transaction/recovery policy  
• modules / execution

## 3.1 Separation of concerns

| **Layer**           | **Responsibility**                                                                            | **Must not do**                                                        |
| ------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| AX observation      | Capture composer, controls, conversation structure, roles, actions, attachments, focus facts. | Infer success from action return codes alone.                          |
| AX action           | Perform paste, focus, key events, explicit control actions.                                   | Hide a failed semantic operation behind unrelated fallback behavior.   |
| Assessment          | Compare observed state with intended payload/baseline and classify progress.                  | Assume immediate visibility after an event.                            |
| Watch orchestration | Stability, execution, submission, retry/recovery ordering.                                    | Re-execute uncertain arbitrary code automatically.                     |
| Durable store       | Atomic current transaction persistence.                                                       | Decide recovery policy.                                                |
| Diagnostics         | Expose before/after snapshots and transition history.                                         | Be tied to one experimental action name when a generic probe suffices. |

# 4\. Composer Observation and Staging Model

All composer interaction is asynchronous. A small text paste may require an unknown processing interval before AX exposes the final draft. A larger paste may additionally transition into an attachment such as Pasted text.txt. The implementation must therefore observe semantic state transitions rather than sleep for a presumed duration and then inspect once.

## 4.1 Composer snapshot

Target: one coherent snapshot should capture, from one observation pass where practical:

- composer availability: available, busy, unavailable;
- editable input existence, AX value, focus state, and relevant actions;
- send/stop control presence and advertised actions;
- observable attachment/placeholder metadata;
- other structural facts needed to distinguish empty, processing, text draft, attachment materialization, and sendable state.


### Composer observation semantics

Composer observations distinguish raw accessibility facts from semantic
interpretation.

In particular, `AXValue` is editor content and must not be treated as a
descriptive label. ChatGPT may expose placeholder text such as `Ask ChatGPT`
through `AXValue` while the editor is empty. Semantic emptiness is therefore
defined as either:

- an empty or whitespace-only `AXValue`; or
- an `AXValue` equal to a non-empty descriptive attribute such as `AXTitle`,
  `AXDescription`, or `AXHelp`.

Generic control-label aggregation is not suitable for this interpretation
because it also includes `AXValue`. Including the content value in the set
against which that same value is compared makes every non-empty draft appear
empty.

The composer snapshot is the shared observation vocabulary for availability,
staging, submission confirmation, and diagnostics. It records at least:

- whether an editable input exists;
- raw editor text;
- semantic emptiness;
- Send-control presence;
- Stop-control presence;
- composer-local pasted-text attachment presence.

Where practical, these facts are derived from the same AX traversal so that
capture-local relationships and transient UI state remain coherent.

## 4.2 Stage assessment

A `StageAssessment` interprets a snapshot relative to the intended payload and
the confirmed empty pre-paste baseline.

The currently implemented staging assessments are:

| **Assessment** | **Meaning** |
| --- | --- |
| `processing` | Neither accepted representation is yet established. Empty, previous, partial, placeholder, or transitional AX state may still be visible. |
| `acceptedAsExactText` | The composer is semantically non-empty and sendable, and its normalized inline representation equals the intended payload. |
| `acceptedAsTransformedText` | The composer is semantically non-empty and sendable, but ChatGPT has transformed the inline AX representation. The difference is retained diagnostically. |
| `acceptedAsAttachment` | A composer-local `Pasted text.txt` representation is present and the composer is sendable. |

Potential future assessments such as explicit `attachmentMaterializing`,
`contradictory`, or richer attachment-ready states should be introduced only
when AX observations provide reliable evidence for those distinctions.

## 4.3 Required staging algorithm

baseline := observeComposer()  
activate ChatGPT and focus composer  
post paste event(payload)  
repeat until deadline:  
snapshot := observeComposer()  
assessment := assessStage(snapshot, baseline, payload)  
record diagnostic transition when materially changed  
if assessment is acceptedAsExactText, acceptedAsTransformedText, or acceptedAsAttachment:  
return success  
fail with timeout + transition history

## 4.4 Rules

- Treat every paste as asynchronous, including payloads that remain inline.
- Establish an observably empty composer baseline before posting the paste.
- Do not classify a paste as failed merely because its final representation is
  not immediately observable.
- Do not predict attachment conversion from payload size. Observe the
  representation ChatGPT chooses.
- Do not accept successful AX mutation as proof that the web editor accepted a
  draft.
- Treat lossless equality with the intended source as diagnostic evidence, not
  a requirement: ChatGPT may normalize whitespace, blank lines, or other editor
  representation details.
- Accept inline staging only after a post-baseline, semantically non-empty,
  sendable state is observed.
- Accept attachment staging only after a composer-local pasted-text attachment
  is observed in a sendable post-baseline state.
- Keep clipboard contents available until staging acceptance is established.
- Treat attachment conversion as a normal representation path rather than an
  exceptional large-payload path.

# 5\. Submission Model

The current validated sending mechanism is keyboard Return/Enter, not AXPress and not a physical click. Submission is asynchronous and must be confirmed against a pre-send conversation boundary.

## 5.1 Validated findings

| **Mechanism**                     | **Observed behavior**                                                                   | **Decision**                                                                  |
| --------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Physical click on Send            | Can submit, but moves pointer and steals focus.                                         | Do not use in normal production send.                                         |
| AXPress on Send                   | Returned success and cleared composer, but did not commit the message in the tested UI. | Do not use as semantic Send. Advertised AX action is not sufficient evidence. |
| Return/Enter key                  | Committed a real user message without moving the pointer.                               | Primary send mechanism.                                                       |
| Absolute latest-role confirmation | Could report false negatives due to AX timing.                                          | Replace with transition relative to a pre-send boundary.                      |

## 5.2 Required send algorithm

before := observeConversationBoundary() // e.g. payload count + tail facts  
ensure ChatGPT remains frontmost and composer is focused  
post Return keyDown/keyUp  
wait until conversation confirms a new committed user turn beyond before  
restore previous application/focused element  
return success

## 5.3 Focus ordering

- Read-only bridge calls connect without activating ChatGPT.
- Staging requires ChatGPT frontmost because Command-V is a global keyboard event.
- Do not restore focus between stage and Enter; doing so caused Enter events to land in Terminal.
- Do not restore focus immediately after CGEvent.post(); event delivery is asynchronous.
- Restore prior focus only after the committed user-turn transition is observed or the send attempt terminates.
- Normal submission must not move the pointer.

# 6\. Watch State Machine

Watch continuously observes the active ChatGPT conversation, executes stable directed assistant content, and submits module output. Polling is passive; activation occurs only when an interaction must inject keyboard input.

## 6.1 Observation semantics

- Require two consecutive equal semantic assistant observations before considering content stable (current implementation behavior).
- A stable assistant response is not consumed while the composer is busy.
- A user-message boundary rearms execution and resets assistant stability.
- One contradictory/transient AX capture must not immediately replace a previously stable observation.
- New assistant content cannot execute again while the turn remains disarmed without a user boundary.

## 6.2 Pending submission semantics

| **Outcome**                        | **Behavior**                                                                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| submitted                          | Clear in-memory pending state and durable transaction.                                                                |
| busy / unavailable                 | Safe to retry on a later available iteration because guarded submission did not mutate the composer.                  |
| exception                          | Retain response, mark submissionFailed, persist submission-failed, and never automatically retry that pending result. |
| new user turn                      | Invalidate obsolete pending output subject to recovery-phase rules.                                                   |
| different stable assistant message | Do not silently apply old pending output to it.                                                                       |

# 7\. Durable Execution and Crash Recovery

The runtime store uses .chatworks-runtime/watch-transaction.json and atomic replacement (temporary file then rename). This protects against partially written JSON during process crashes. It is not a claim of power-loss durability because file/directory fsync is not currently part of the design.

## 7.1 Transaction phases

| **Phase**         | **Stored data**            | **Meaning**                                                                                                             |
| ----------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| executing         | messageIdentity            | Arbitrary assistant-provided execution began; side effects are uncertain.                                               |
| pending           | messageIdentity + response | Execution completed and exact response is available; submission is not confirmed.                                       |
| submission-failed | messageIdentity + response | Submission threw after potentially mutating UI; automatic retry is prohibited.                                          |
| acknowledged      | messageIdentity            | Human explicitly resolved/discarded uncertain/recovered work; originating command must not execute automatically again. |

## 7.2 Ordering guarantees

stable executable assistant message  
→ persist executing  
→ execute arbitrary module code  
→ persist pending(response)  
→ attempt submission  
success → clear transaction  
exception → persist submission-failed(response)

## 7.3 Recovery policy

| **Recovered phase** | **Policy**                                                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| executing           | Block all automatic assistant execution. Never rerun. Human may recover discard, producing acknowledged.                                            |
| pending             | Never re-execute originating command. Restore/submission is allowed only when recovery is safely reconciled with conversation context.              |
| submission-failed   | Restore as failed pending; zero automatic execution and zero automatic submission. Human may recover retry (→ pending) or discard (→ acknowledged). |
| acknowledged        | Do not execute the acknowledged originating message. A confirmed later user boundary can clear the acknowledgement.                                 |

## 7.4 Recovery CLI

npm start -- recover # display durable transaction, read-only  
npm start -- recover discard # acknowledge/discard allowed recovered work  
npm start -- recover retry # submission-failed only: rearm stored response as pending

Validated: recover is read-only; graceful Ctrl-C does not remove submission-failed state; retry preserves identity and response while changing submission-failed to pending.

## 7.5 Durable identity

Durable message identity is SHA-256 over the deterministic semantic message identity, serialized as sha256:&lt;64 lowercase hex digits&gt;. Hashing is applied only at the persistence boundary; in-memory semantic identity remains transparent and deterministic.

## 7.6 Unresolved conversation identity problem

A durable pending response can outlive the originating assistant message being the latest message. Matching only the latest message identity is therefore too restrictive, but blindly submitting the response after the conversation advances could post it into the wrong chat. Current sidebar references expose only title and transient enumeration index; neither is a reliable durable conversation identifier. Recovery must remain conservative until a stable conversation identity can be obtained or an equivalent safe binding is designed.

# 8\. Diagnostics and Compatibility Strategy

Diagnostics are a first-class compatibility surface because ChatGPT Desktop and its embedded web UI will change. Diagnostics should expose capabilities and state transitions rather than preserve experiment-specific methods indefinitely.

## 8.1 Generic diagnostic capabilities

The maintained diagnostic surface is intentionally small:

- Composer snapshot: candidate inputs, controls, actions, focus/readiness
  attributes, and relevant nearby UI.
- Conversation snapshot: payload candidates, latest-assistant selection,
  sibling structure, and selected payload tree from one coherent AX capture.
- Generic element inspection by label.
- Generic actionable-control inspection by label.
- Raw advertised AX attribute inspection for maintenance and compatibility
  investigation. This is an escape hatch for discovering attributes not
  represented in the curated snapshots; observed attributes must not be
  assumed stable merely because they are exposed.
- Production staging/submission transition diagnostics for asynchronous
  semantic failures.

Mutating AX-action, keyboard, paste, and focus probes are compatibility tools,
not permanent production requirements. When a ChatGPT update requires
characterization of one of those mechanisms, diagnostics should isolate the
requested mechanism and report before/after observations without silently
falling back to a different interaction.


## 8.2 Diagnostic output requirements

- Report semantic facts, not only raw AX error numbers.
- Include elapsed time and only materially changed observations to keep histories readable.
- Preserve enough raw fields to diagnose a future ChatGPT update.
- Do not make diagnostics silently fall back to a different interaction mechanism; the requested mechanism must be isolated.
- Production failures should reference the same observation/assessment vocabulary used by diagnostics.

Example staging timeout:  
0.00s empty, send=false, attachments=0  
0.18s empty, send=false, attachments=0  
0.71s attachment placeholder  
2.43s attachment=Pasted text.txt, send=true  
<br/>Example text path:  
0.00s previous text  
0.12s empty  
0.31s text=1,204 chars, send=false  
0.58s text=4,821 chars, send=true


### Submission confirmation

Enter-based submission does not depend on finding or pressing the Send control.
The Send control is a staging/readiness observation; it is not a precondition
of the Enter interaction primitive.

`send()` retains the exact AX composer element selected for submission and
observes that same element during confirmation. Rediscovering an arbitrary
editable input can confuse the staged composer with another empty AX editor.

Submission has a single semantic authority. Once staging begins, wrappers must
not reinterpret a submission failure as success from composer emptiness or
other weaker signals.

A successful submission requires both:

1. the staged representation is consumed from the same composer; and
2. a committed user turn is observed after the same assistant boundary.

For inline staging, consumption means the same composer becomes semantically
empty. For attachment staging, the composer-local staged attachment must
disappear.

Conversation payload counts and capture-local traversal indices are not stable
identities across independent AX traversals. Confirmation therefore uses a
semantic fingerprint of the pre-send assistant payload and establishes the
assistant-to-user predecessor relationship within one post-send capture.

# 9\. Validated Scenarios

| **Scenario**                                 | **Observed result**                                                                                                    |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Sustained watch (>1 minute)                  | Single execution/submission; no recursive execution or polling spam.                                                   |
| Exceptional submission under watch           | Error logged once; no per-poll destructive retry.                                                                      |
| Real executing crash (SIGKILL)               | executing transaction survived; restart blocked automatic re-execution; explicit acknowledgement path worked.          |
| Real pending crash during blocked submission | pending transaction survived; restart submitted stored response without rerunning command.                             |
| submission-failed persistence                | State remained through polling, Ctrl-C, and read-only recover.                                                         |
| recover retry                                | submission-failed transformed to pending with same identity and response.                                              |
| Passive polling                              | After connect activation split, repeated assistant/composer reads did not steal focus.                                 |
| Enter-only diagnostic                        | Established that keyboard Enter can commit without pointer movement. The original diagnostic used payload-count growth, which is no longer considered sufficient production confirmation. |
| AXPress diagnostic                           | AXPress returned success and changed composer state but did not reliably represent semantic Send; must not be trusted. |
| Small inline output | Validated end-to-end with semantic composer emptiness and correlated submission confirmation. |
| Normalized multiline inline output | Validated end-to-end when ChatGPT removed blank lines from the AX editor representation. |
| Large/verbose output converted to `Pasted text.txt` | Validated end-to-end after semantic composer-emptiness correction: attachment materialized, Enter submitted it, and the user turn appeared. |

# 10\. Known Failure Modes and Lessons

| **Failure**                                                                               | **Lesson / requirement**                                                         |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Direct non-empty AXValue assignment did not create a reliable web-editor draft.           | Use real paste and semantic acceptance observation.                              |
| Synthetic Command-A caused ChatGPT crashes in experiments.                                | Do not use Command-A for clearing; clear through safer AX/editor-specific means. |
| AXPress advertised by Send returned success without trustworthy semantic send.            | Action availability/success is not semantic confirmation.                        |
| Restoring focus before Enter delivery sent Enter to Terminal.                             | Keep target application frontmost until committed transition is observed.        |
| Physical click fallback made successful tests appear stable while moving pointer/focus.   | Avoid semantically different hidden fallbacks in production paths.               |
| Large paste became Pasted text.txt after a delay.                                         | Representation is chosen asynchronously by ChatGPT; observe rather than predict. |
| Even ordinary text can take an unknown short time to become observable.                   | All staging begins in processing state.                                          |
| Latest-message identity could not reconcile pending recovery after conversation advanced. | Need durable conversation binding before relaxing recovery.                      |
| Watch initially activated ChatGPT every poll.                                             | Read-only connect must be passive; activation is command-dependent.              |


A particularly important regression was caused by defining semantic composer
emptiness with `controlLabels(of:)`. That helper aggregates `AXTitle`,
`AXDescription`, `AXHelp`, and `AXValue`. Comparing the current `AXValue`
against that set is tautological for non-empty content and caused real drafts
to be classified as empty. This single faulty primitive contaminated staging,
submission-consumption confirmation, and an older guarded-recovery fallback.

General rule: generic AX attribute aggregation must not be reused for semantic
classification when it mixes descriptive metadata with content attributes.

# 11\. Consolidation Plan

The current implementation contains working mechanisms accumulated through experiments. Consolidation should preserve validated behavior while replacing local timing assumptions with shared observations and assessments.

## 11.1 Phase A — Composer model

Status: implemented and live-characterized.

- `ComposerSnapshot` is the shared observation vocabulary.
- `StageAssessment` is evaluated relative to a confirmed empty baseline.
- Text and attachment representations share one bounded observation loop.
- Inline editor normalization is accepted and diagnosed rather than treated as
  staging failure.
- Composer availability is derived from the same snapshot vocabulary, with Stop
  taking precedence over Send during transient captures.
- Transition history is retained for staging failures and characterization.

Remaining work in this area should focus on characterization and regression
tests rather than adding speculative states.

## 11.2 Phase B — Interaction primitives

Status: implemented and live-characterized.

- Passive and activating connection are explicit; read-only polling does not
  activate ChatGPT.
- Paste and Enter are the explicit keyboard-dependent staging/submission
  primitives.
- Focus captured before activation is retained through stage+send and restored
  only after submission confirmation terminates.
- Normal submission has no pointer-click or AXPress fallback.
- Physical clicks remain explicit primitives for unrelated ChatGPT controls
  where AX actions are unavailable or unreliable.
- Obsolete Send-control-specific error/helper paths and the unused bridge-wide
  focus-restoration policy have been removed.


## 11.3 Phase C — Diagnostics

Status: implemented and live-characterized.

- Read-only diagnostics expose generic element and actionable-control
  inspection.
- Composer diagnostics expose one coherent composer-oriented snapshot including
  candidate inputs, Send controls, nearby buttons, actions, enabled/focused
  state, and AXValue settability.
- Conversation diagnostics expose one coherent structural capture containing
  payload candidates, latest-assistant selection, sibling structure, and the
  selected payload tree.
- Conversation traversal indices and parent/child references belong to the same
  capture. Live characterization confirmed that selected roots resolve in the
  captured tree and that child references are internally coherent.
- Experiment-specific conversation projections and composer exploration helpers
  have been removed after their useful observations were incorporated into the
  consolidated snapshots.
- Production staging and submission retain transition/evidence diagnostics at
  the points where asynchronous semantic failures occur.
- Generic mutating action, keyboard, paste, or focus probes are not maintained
  speculatively. They should be introduced as isolated diagnostics when a
  concrete ChatGPT compatibility regression requires them, without changing
  production interaction semantics.

Transition diagnostics remain part of production/development tooling because
ChatGPT's Electron/web UI and AX representation can change independently of
ChatWorks. Diagnostics report observed state transitions and semantic evidence
rather than only opaque AX error codes.


## 11.4 Phase D — Recovery completion

Status: blocked on durable conversation identity.

The current recovery model remains conservative when retained state can no
longer be proven to belong to the current conversation. Safe automatic
reconciliation requires an identity that binds durable ChatWorks state to the
same ChatGPT conversation across navigation and process restarts.

### Conversation identity characterization

The ChatGPT sidebar was inspected through AX using the advertised scalar
attributes of chat title/action controls and the title element's ancestor
chain.

Observed results:

- Sidebar chat controls expose their title but no observed conversation URL or
  backend conversation identifier.
- `AXDOMIdentifier` is empty on individual chat controls and chat-specific
  ancestors.
- Shared UI ancestors expose structural identifiers such as
  `app-shell-sidebar`; these identify sidebar structure, not an individual
  conversation.
- `ChromeAXNodeId` distinguishes individual chat controls and chat-specific
  enclosing groups.
- In a sample of 27 sidebar chats, all observed `ChromeAXNodeId` values
  remained unchanged after navigating to another conversation and back.
- An initial restart experiment also appeared to preserve the values, but the
  process restart had not been independently verified and therefore was not
  accepted as evidence.
- In a subsequent verified experiment, the ChatGPT application PID changed
  from `73102` to `26801`; all 27 previously observed conversations remained
  present, but every compared title/group `ChromeAXNodeId` pair changed.

Therefore `ChromeAXNodeId` is useful as an AX diagnostic identifier within the
observed application lifetime, but it is not a durable conversation identity
and must not be used to reconcile persisted recovery state after restart.

The raw AX attribute diagnostic used for this characterization remains useful
as maintenance tooling. Its purpose is discovery and compatibility diagnosis,
not to confer stability guarantees on the attributes it observes.

Until ChatWorks can observe or establish a durable conversation identity,
recovery must fail closed when retained state cannot be proven to belong to the
current conversation. Title and sidebar position are insufficient for that
proof.


# 12. Acceptance Criteria for the Consolidated Interaction Layer

- Watch can run in the background for at least several minutes without stealing
  focus during polling.
- A small text result can be staged, submitted with Enter, structurally
  confirmed, and focus restored without pointer movement.
- A normal text paste that is temporarily unobservable is treated as processing
  rather than immediate failure.
- A paste converted to an attachment is observed through materialization and
  accepted without size-based prediction.
- Staging timeout reports transition history sufficient to explain the last
  observed state.
- No production send path silently changes from Enter to pointer click or
  AXPress.
- An execution crash cannot cause automatic duplicate execution after restart.
- A pending crash can recover stored output without re-execution when safely
  reconciled.
- A submission exception cannot produce per-poll retries.
- Maintained diagnostics provide coherent composer and conversation snapshots,
  generic element/control inspection, and raw AX attribute discovery for
  compatibility investigation. Interaction-specific probes can be introduced
  when a concrete ChatGPT update requires characterization.

# 13. Open Questions

The following questions remain unresolved:

- What attachment metadata is reliably observable during
  placeholder/materialization/ready phases?
- What bounded staging deadline and polling/backoff policy balances
  responsiveness with slow attachment creation?
- Can staging avoid application activation in the future through a more direct
  editor integration, or is real keyboard paste inherently required?
- Should power-loss durability be added with explicit `fsync` for the
  transaction file and directory?
- How should diagnostics version/record ChatGPT app version and observed AX
  capability changes for regression comparison?

Two questions from the original specification have been investigated:

- Durable conversation identity remains unavailable through the AX attributes
  characterized so far; see Phase D.
- Conversation snapshots now derive payload selection, sibling structure, and
  payload-tree relationships from one AX capture, avoiding the earlier
  capture-local relationship mismatch.

# Appendix A — Current Recovery Commands

The recovery command surface must be kept synchronized with the current CLI.
The original specification documented:

```text
npm start
npm start -- once
npm start -- recover
npm start -- recover discard
npm start -- recover retry
