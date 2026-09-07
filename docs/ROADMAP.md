# Kinema Roadmap

This roadmap is a forward planning document. It describes what Kinema should build next and why, not a historical archive of completed implementation work.

Completed foundation work, including Phases 1-7 and completed portions of Phase 8, is documented in `docs/PROJECT_CONTEXT.md`. That file remains the canonical record of implemented state, architecture decisions, known limitations, and milestone history.

## Product Direction

Kinema is a configurable business-operations platform: structured enough to protect operational data, flexible enough to model each organization's real objects, relationships, processes, roles, and workflows.

Roadmap decisions should keep these principles intact:

- AI configures deterministic software; AI does not execute routine operational work that the product can perform reliably.
- The system should be flexible but safe: preserve stable identities, avoid silent rewrites, and prefer reversible lifecycle states over destructive changes.
- Worker UX should hide configuration complexity. Builders configure objects, fields, relationships, automations, process templates, roles, and policies; workers should experience purposeful operational surfaces.
- Build generic foundations with specific experiences. A new business object should work immediately in records, tables, relations, views, automation, process, search, and activity surfaces.
- Avoid accidental data inconsistency. Do not casually cascade, null, delete, or reinterpret dependent data.
- Compete on configurable operational structure, not commodity project-management lists.

## Phase 8 - Operational Foundation

Phase 8 turns Kinema from a capable prototype into a daily operational system: clearer worker surfaces, better business-object navigation, import/search/activity, recurrence, notifications, and administrator governance.

### 8E - Admin & Governance

**Status:** Completed once the current Workspace Health slice closes. Implemented details and history live in `PROJECT_CONTEXT.md`.

Future governance, audit, workspace-health, impersonation, and production-support evolution should be planned under [Governance, Audit & Workspace Hygiene](#governance-audit--workspace-hygiene), not as open-ended Phase 8E work.

### 8F - Connectivity

**Status:** Completed (8F.1 CSV Export, 8F.2 Outbound Webhooks, 8F.3 Read-only API Foundations, 8F.4 Outbound Email/Provider Infrastructure, 8F.5 External Event/Webhook Waits). Implemented details and history live in `PROJECT_CONTEXT.md`. Phase 8 is now complete; Phase 9 is the active roadmap focus.

Deferred connectivity work (API writes, OAuth, third-party app registration, integration marketplace, GraphQL, broad rate-limiting infrastructure, a generic webhook/email provider abstraction) was explicitly out of scope for 8F.1-8F.5 and remains unplanned rather than promised for a specific future phase.

**Goal:** Establish the practical edges Kinema needs to exchange data and operational events with the outside world, without pretending to be an integration marketplace.

Likely scope:

- API foundations for authenticated programmatic access to core workspace data and operations.
- Webhooks or outbound event delivery for meaningful operational events.
- Import/export maturity beyond the current one-object CSV import, including CSV export and clearer data movement workflows.
- Outbound email/provider infrastructure where useful for invitations, notifications, and later collaboration.
- External event or webhook waits if they fit the existing deterministic Process model.
- Operational safeguards for external side effects: idempotency, retry visibility, failure states, auditability, and administrator configuration.

Boundaries:

- Keep integration behavior deterministic and inspectable.
- Prefer a small set of durable provider/event primitives over a broad marketplace.
- Keep email/provider infrastructure separable from the collaborative workflows that may later use it.

## Phase 9 - Table & View Experience

**Status:** Completed (9.1 column show/hide-reorder and sticky headers, 9.2 Choice/Select field type, 9.3 inline relation editing and link-aware cells, 9.4 table polish and usability, 9.5 bulk archive/restore actions, 9.6 Choice palette/pill/cell visual polish, 9.7 table editing interaction polish). Implemented details and history live in `PROJECT_CONTEXT.md`. Phase 9 is now complete; Phase 10 is the next roadmap focus.

**Goal:** Make Kinema's core business-object table experience genuinely delightful for everyday work: Airtable-class in quality, but grounded in Kinema's stronger operational model.

This is a major product phase, not cosmetic polish. Business objects are the center of Kinema's data model; their collection and view experience should feel fast, legible, editable, and trustworthy.

### Table Fundamentals

- Sorting that feels reliable, persists where appropriate, and respects typed values.
- Filtering that is easier to create, understand, edit, and recover from.
- Stronger Saved Views: clearer view management, defaults, stale-reference handling, view-specific column/sort/filter state, and possibly richer operators.
- Column show/hide and reorder are done (Phase 9.1); resizing remains deliberately deferred — evaluated during Phase 9.4 and found not warranted by any concrete constraint, not simply unstarted.
- Sticky headers exist (Phase 9.1). Useful row affordances and polished visual hierarchy continue incrementally; density controls remain deliberately deferred — evaluated during Phase 9.4 dogfood (including a wide, many-column table) and found no concrete evidence of need.
- **Empty and filtered-empty states — done (Phase 9.4):** a truthful four-way precedence (genuinely empty / all records archived and hidden / an unsaved filter zeroing results / a saved view's own filter zeroing results), each with the correct resolving action where one applies. Loading and error states were deliberately not built: the table route is a plain, atomically server-rendered page with no existing `loading.tsx`/`error.tsx` pattern anywhere in the app to extend, and no evidence a client-loading state would ever actually be visible.
- **Choice pill/palette, cell visual polish — done (Phase 9.6):** a stronger Choice pill treatment, the fixed color palette expanded 6 → 12 with contrast/distinctness independently verified (migration `0084`), a keyboard-accessible swatch picker replacing the plain color `<select>`, and a 2-line clamp with a keyboard-accessible More/Less toggle for long plain-text cells (identity field and linkified URL/email values excluded). Visual/presentation only — no new field types, sorting/filtering, or authorization changes. Implementation and verification detail in `PROJECT_CONTEXT.md`.

### Editing & Data Quality

- Cautious in-place editing beyond the current primitive-cell foundation, with explicit commit/cancel behavior and server-authoritative validation.
- **Inline relation editing from the table, and archived-target write integrity — done (Phase 9.3):** the table's relation pill is now the inline-edit trigger (dropdown of active targets plus the row's own current target if archived); record-detail's relation chip stays navigation-only. Migration `0082` closed a genuine, previously-unenforced gap at the canonical write RPCs — an archived, wrong-type, or foreign-workspace relation target could be assigned via direct RPC use with no server-side check. Implementation and verification detail in `PROJECT_CONTEXT.md`. Deliberately deferred, not yet started: a scalable relation-picker (search/pagination) for high-cardinality target objects, bulk/multi-relation editing, and any relation-shape change.
- **Clickable URLs and email values in text cells — done (Phase 9.3):** whole-value-only detection (never a substring match); a separate compact Edit affordance keeps linkification from conflicting with inline text editing. Relation chips were already clickable before this phase; see the item above for what changed there.
- **Table editing interaction polish — done (Phase 9.7):** a consistent click model across every cell type (confirmed already correct almost everywhere on inspection), a native Unset/Yes/No radio control for Boolean, a small viewport-clamped anchored popover for Choice/Relation/Text editing (replacing a cramped in-cell `<select>`/single-line `<input>`) -- Text specifically gained a multiline `<textarea>` after dogfood found a single-line input showed only a small fragment of a paragraph-length Notes value -- a pencil icon replacing the word "Edit" wherever a value already owns its own click, and removal of the Actions column's now-redundant standalone Edit link. No new field types, migration, or authorization changes. Implementation and verification detail in `PROJECT_CONTEXT.md`.
- **Bulk actions — archive/restore done (Phase 9.5):** row selection (per-row/header checkbox, "Select all N records shown," resets on filter/sort/archived-toggle change) plus bulk archive and bulk restore, backed by one narrow all-or-nothing RPC (migration `0083`) — no cascade, no relation rewrite, records already in the target state inside a mixed batch keep their original `archived_at` untouched. Implementation and verification detail in `PROJECT_CONTEXT.md`. Bulk field update was evaluated and deliberately deferred, not merely unstarted: no narrow, atomic way was found to reuse Choice/relation write-integrity checks (required-field, active-option/active-target validation) across a batch without either a materially larger transactional RPC or a non-atomic per-record loop; revisit only as its own dedicated slice if real demand justifies that cost. Bulk delete remains excluded by design.
- Singular and plural business-object labels so collection headings, navigation labels, and record-detail labels can be correct without runtime pluralization guesses.

### Field & Relation Model Improvements

- **Choice / Select field type — done (Phase 9.2):** single-select, builder-defined options stored as stable IDs with a fixed color palette, add/rename/reorder/recolor/archive/restore lifecycle, Choice-aware filtering (`is`/`is not`/`is empty`/`is not empty`) and configured-position sorting, colored pill display, CSV round-trip, and read-only API resolution. Implementation and verification detail in `PROJECT_CONTEXT.md`. Deliberately deferred, not yet started: multi-select, workflow/process condition and action support, `is any of`/`is none of` filters, and any status-workflow semantics beyond plain option display.
- **Multi-value / many-to-many relations:** support real many-to-many needs through a designed storage/model approach, whether array-valued relation storage, explicit join entities, or another architecture. This should not be patched around with presentation-only reverse lists.
- Better relation creation/editing flows, including cases where users need to create, link, unlink, and inspect related records without losing context.

### Scale & Performance

- DB-backed pagination for entity list pages and other full-table reads.
- Large-table performance work, including virtualization only if real usage warrants it.
- Real aggregate counts where the UI currently derives counts by fetching rows.
- Continued search/list performance tuning only when product scale or measured query behavior justifies it.

## Phase 10 - Collaboration

**Status:** Completed (10.1 record-level Discussion, 10.2 record-comment mentions with narrow in-app notifications, 10.3 Process Step Run Discussion, 10.4 record-level Request for Input, 10.5 Process Step Run Request for Input). Implemented details and verification live in `PROJECT_CONTEXT.md`. Phase 10 is now complete; the next roadmap focus is unset -- see `PROJECT_CONTEXT.md`'s Phase 10 closure recommendation for why further collaboration work was deliberately not continued on roadmap momentum alone.

**Goal:** Add the human collaboration layer around Kinema's operational objects and process work.

Phase 10 should make it natural for people to discuss, request input, and preserve context directly where work happens.

Delivered scope:

- Record-level comments/discussions (10.1), record-comment mentions with in-app notifications (10.2), human-operable Process Step Run discussion (10.3), record-level Request for Input (10.4), and Process Step Run Request for Input (10.5) together give both records and process-step work three consistent, non-overlapping collaboration primitives: conversation, attention, and explicit response obligation. None of it became a generic chat system or an alternate task engine.
- Durable conversation history with clear authorship, timestamps, and permission behavior -- done, at both the record and process-step level.
- Notification integration for comments, mentions, and input requests -- done, at both levels, in-app only.

Deliberately not pursued as part of Phase 10, remaining genuinely open for a future phase if a concrete need justifies them (not simply "next" by momentum):

- Email delivery and preferences for collaborative notifications, using provider infrastructure if Phase 8F establishes it. No dogfood evidence yet that in-app notifications are insufficient.
- Attachments/files for comments, record context, or process evidence. A materially larger scope (storage, validation, a new capability class) than anything Phase 10 built.
- Subscriptions/following (passive, non-explicit notification) -- a different shape from every primitive Phase 10 actually shipped, all of which are explicit (mention, request, assignment).

Design constraints:

- Keep collaboration attached to deterministic operational state; comments should not become an alternate task engine.
- Separate notification infrastructure from collaboration semantics. Phase 8F may provide email/provider capability; Phase 10 decides how comments and mentions use it.
- Preserve workspace boundaries, actor history, impersonation semantics, and future audit expectations.

## Phase 11 - Process Runtime Administration

**Status:** Complete. 11.1 (Cancel Process Run), 11.2 (Reassign Active Human Work), and 11.3 (Administrative Reassignment Authority) are all complete -- migrations `0092`/`0093`/`0094`/`0095`/`0096`, implementation and verification detail live in `PROJECT_CONTEXT.md`. Phase 11 -- Process Runtime Administration is now complete.

**Goal:** Let authorized users safely handle two common real-world exceptions in an active Process Run -- abandoning a run and changing who owns active human work -- without mutating the Process Template, reversing completed history, or weakening deterministic runtime guarantees.

This phase followed a dedicated investigation (current-state findings, runtime invariants, and a capability-by-capability assessment covering reassignment, cancellation, skip, reopen, send-back/rework, delegation, escalation, and manager/team intervention) that recommended a small, contained slice sequence over either a full workflow-engine expansion or deferring the whole area. Reopen and arbitrary send-back/rework were explicitly rejected during that investigation, not merely deferred: every completion path in the Process runtime is provably forward-only and write-once, with no reverse-transition precedent anywhere in the codebase's migration history, and reopening/reworking would require reversing already-cascaded routing/join/side-effect state that has no existing mechanism to undo.

Delivered scope (11.1, 11.2, 11.3):

- Cancel Process Run (11.1): a `cancelled` status on both `ProcessRun` and `ProcessStepRun`, distinct from `completed`/`skipped` (cancellation is a different historical fact from routing determining a step was not taken, and is never represented as `skipped`). Every active/pending StepRun transitions to `cancelled`; every already-completed/skipped StepRun and its routing/approval/comment/input-request history is preserved exactly. Requires a reason (enforced at both the RPC and the database layer), records impersonation-aware actor/effective-actor attribution, emits a best-effort Activity event, and frees the origin record for an immediate new run. Gated on the existing `processes.operate` capability only -- no new capability was added.
- Reassign Active Human Work (11.2): the current assignee of an active `human_task`/`approval` StepRun can hand it to another current workspace member -- self-service, effective-user-aware. A new `assignment_generation` counter gives every handoff its own distinct episode, so notification dedup keys can tell a fresh episode apart from a prior one: generation 1 keeps the exact pre-existing unsuffixed keys (preserving already-delivered notification history untouched), generation 2 and beyond use generation-suffixed keys, guaranteeing a reassigned user reliably gets correct assignment/due-soon/overdue notifications rather than silently receiving none. `due_at` is preserved exactly, never recalculated. A `step_reassigned` Activity event records each transition with frozen from/to labels and actor/effective-actor attribution. Gated on the existing `processes.operate` capability only -- no new capability was added.
- Administrative Reassignment Authority (11.3): an appropriately authorized member -- not merely any `processes.operate` holder -- can reassign someone else's active `human_task`/`approval` StepRun. Authorization is a capability conjunction, not a new capability and not a hard-coded Workspace administrator check: the caller must hold `processes.operate` **and** `workspace.manage_members` **and** `workspace.manage_roles`, all three, reusing an authorization idiom already established for comment moderation and input-request cancellation. The built-in Workspace administrator naturally qualifies because it holds every capability; a custom role assembled with exactly these three also qualifies. `private.managed_user_ids`/manager-team visibility remains read-only and grants no mutation authority. A reason is mandatory (unlike self-reassignment, where it stays optional). The RPC unconditionally rejects an active impersonation session before evaluating anything else -- administrative reassignment is a real workspace-governance action and is never exercised through impersonation -- and the UI control is separately hidden while impersonating. `due_at` preservation, the `assignment_generation` counter, and the generation-aware `step_assigned` notification are unchanged from 11.2; the outgoing assignee receives no notification, and the existing `step_reassigned` Activity event is reused, truthfully attributing the administrative actor. The control appears only on Process Run detail, for a step the viewing administrator does not already own; Team Work remains entirely read-only.

Explicitly out of scope for this phase (rejected or deferred, not simply unstarted):

- Manual Skip, Reopen, and arbitrary send-back/rework -- see the rejection reasoning above.
- Runtime graph rewiring, dynamic role/team/expression assignment, timed delegation, escalation-policy expansion, and bulk reassignment/workforce-planning tooling.
- Deadline reset on reassignment -- both 11.2 and 11.3 preserve `due_at` unconditionally; no option to recalculate it was added or is planned.
- A notification to the outgoing assignee when their work is administratively reassigned away -- deliberately left out of 11.3 (the existing `step_reassigned` Activity entry is judged sufficient); would need its own separate product decision if reconsidered later.

Design constraints:

- Preserve deterministic execution and immutable routing history -- a runtime intervention may only affect currently active/pending state, never a step that has already completed or was already routed around.
- Prefer new durable events over reinterpreting or rewriting historical rows, matching this project's established pattern for `routing_result`, `decided_by_*`, and now `cancelled_at`/`cancellation_reason`.
- Do not silently turn manager/team visibility scope (`private.managed_user_ids`) into mutation authority.

## Phase 12 - People Foundations

**Status:** In progress. 12.1 (People Identity Foundation) is complete -- migration `0097`/`0098`/`0099`, implementation and verification detail live in `PROJECT_CONTEXT.md`. 12.2 (People-Sensitive Read Access) is complete -- migrations `0100`-`0104` (`0104` a narrow corrective grant fix found and closed during verification), implementation and verification detail live in `PROJECT_CONTEXT.md`. 12.3.1 (Quality Review Lifecycle & Authority) is complete -- migrations `0105`-`0107` (`0106`/`0107` corrective, found and closed during verification), implementation and verification detail live in `PROJECT_CONTEXT.md`. 12.3.2 (Person Review History Experience) is complete -- migrations `0108`-`0109` (`0109` corrective, an exception-safety fix to the shared Review Date validator), implementation and verification detail live in `PROJECT_CONTEXT.md`. Sequencing for the next People-Experience slice (further 12.3.x work, or Goals/Performance Cycles) is left for review, not automatically started.

**Goal:** Let a configurable, metadata-defined Person business record be durably bridged to an authenticated workspace member identity, and -- once that bridge's own safety is proven -- eventually support performance-management-style use cases (quality reviews, goals) as ordinary business objects, without building a bespoke HR/person-record subsystem and without prematurely broadening authorization into a general policy engine.

This phase followed a dedicated investigation into whether Kinema's existing generic entity/relation/view/process architecture could already model performance-review and goal-tracking scenarios, and what was genuinely missing. The investigation found the data-modeling side already fully generic (Quality Review, Performance Cycle, Goal, and Goal Check-In all model cleanly as ordinary EntityTypes with no new primitive) but identified two real gaps: no durable link between a business record and a workspace member identity, and no row-level read restriction narrower than "whole workspace" anywhere in this schema. The recommendation -- approved -- was to ship the identity link alone first (12.1, low risk, independently valuable), and defer the visibility question to its own dedicated authority investigation (12.2) before any people-sensitive data exists, mirroring how Phase 11.3's authority question was kept out of 11.1/11.2.

Delivered scope (12.1, 12.2, 12.3.1, 12.3.2):

- People Identity Foundation (12.1): a workspace may optionally designate exactly one metadata-defined EntityType as its Person type (`workspaces.person_entity_type_id`, `schema.manage`-gated). A new `entity_record_person_links` mapping table provides an explicit, optional, 1:1 bridge between one Person EntityRecord and one workspace member `user_id`, structurally workspace-safe via composite FKs. Person records may exist without workspace accounts; workspace members may exist without Person records; linking is always explicit/manual (`workspace.manage_members`-gated), never automatic on invitation and never inferred from email/name matching. Links survive member deactivation and Person-record archival; a linked Person record or the currently-designated Person type cannot be safely hard-deleted until explicitly unlinked/undesignated; every link/unlink is durably recorded as a `person_linked`/`person_unlinked` event; all three governance RPCs (designation, link, unlink) are unavailable during active impersonation. No new capability was introduced, and existing `workspace_reporting_relationships`/teams/My Work/Team Work/Process assignment remain untouched, keyed on `user_id` as before. **No people-sensitive row visibility was introduced in 12.1** -- the existence of a link is readable by any workspace member; only mutation was capability-gated.
- People-Sensitive Read Access (12.2): an EntityType may be marked `people_sensitive` with a designated subject relation (and optional author/reviewer relation) targeting the workspace's Person type, plus three fixed read toggles (subject/manager/author-can-view) and a new `people_data.view_all` privileged-override capability. A single DB-layer predicate (`private.can_view_people_sensitive_record`) is enforced both through RLS (for ordinary reads) and independently re-implemented inside every SECURITY DEFINER mutation/read RPC RLS cannot reach (record create/update/archive/delete, search, comments, Request for Input) -- manager visibility is dynamic, resolved live off `workspace_reporting_relationships` rather than frozen at record-creation time. The public API refuses sensitive types conservatively (uniform not-found/empty-page, no attempt to map interactive identity semantics onto an API key). Process/Workflow attachment to a people-sensitive type is rejected in both directions. Changing a sensitive record's own subject/author relation after creation requires a separate governance-authority check, distinct from ordinary `records.operate`. Full detail, including the four design migrations and one corrective grant-fix migration, lives in `PROJECT_CONTEXT.md`.

- Quality Review Lifecycle & Authority (12.3.1): a people-sensitive EntityType may additionally be marked `quality_review`, gaining a Draft/Finalized status lifecycle backed by a designated Choice status field and its Draft/Finalized options. Creation self-binds an ordinary caller's Reviewer relation to their own linked Person, with a governed create-on-behalf path reusing 12.2's existing governance authority. A Draft is visible only to its Reviewer or real, non-impersonating governance authority; Finalized resumes ordinary 12.2 subject/manager/reviewer visibility. Draft content is ordinarily editable only by the Reviewer; a Finalized record cannot be directly edited, archived by non-governance actors, or hard-deleted by anyone -- correction is Reopen (governance-only) -> Draft edit -> re-Finalize. Enforcement for write/delete lives in table-level triggers, not RLS, since the generic mutation RPCs run under an elevated role RLS does not reach. Full detail, including all three migrations (`0105`-`0107`, `0106`/`0107` corrective), lives in `PROJECT_CONTEXT.md`.

- Person Review History Experience (12.3.2): a Quality Review-configured EntityType may additionally designate a Review Date field (Date type) and an optional Overall Result field (Choice type), narrowly scoped presentation metadata separate from the 12.3.1 lifecycle designation. Once a Review Date field is designated, every Finalized review of that type is guaranteed to carry a valid date -- enforced both at designation time (every existing Finalized record is validated, with a truthful invalid-count rejection and no rewriting) and at Finalize time (rejected without a valid date). A new read RPC (`list_person_quality_reviews_authorized`) returns a Person's complete, uncapped, Finalized-only Quality Review history across every so-configured EntityType, newest-first, with Reviewer identity independently visibility-checked and redacted (not the whole row) when the Reviewer's own Person record is hidden from the caller. The Person record-detail page renders this as a "Review history" section (Date, optional Result pill, Reviewer or "Reviewer unavailable", a type label only when more than one Quality Review type is present, a link to the full review) placed above generic Related. The redundant Quality Review subject relation group is suppressed from generic Related on Person pages specifically -- driven only by the source EntityType's `quality_review`/`subject_person_field_id` metadata, never by name/slug inference -- while the Reviewer/author relation group and every other relationship remain untouched; this is presentation-only deduplication, not an authorization change. Full detail, including both migrations (`0108`-`0109`, `0109` corrective), lives in `PROJECT_CONTEXT.md`.

Explicitly out of scope for this phase (rejected or deferred, not simply unstarted):

- Payroll, compensation, recruiting/ATS, leave/PTO management, benefits, disciplinary workflows, and any generic HRIS replacement.
- Automated/algorithmic employee ranking and AI-generated performance judgments -- explicit, reviewer-entered scores are in scope for 12.3; Kinema inferring or computing a composite performance judgment is not, and would need its own separate product decision if ever reconsidered.
- A broad ABAC/policy-language engine, and a generic dashboard/page-builder -- 12.2's visibility rule stayed a small, fixed mechanism, not a configurable policy language; 12.3 UX must stay a purposeful record-detail section, not a generic builder.
- Manager mutation authority arising merely because manager/team visibility (`private.managed_user_ids`, Team Work) exists -- visibility and mutation authority remain separate axes, exactly as established in Phase 11's design constraints, and unchanged by 12.2/12.3.1.
- Field-level ACLs, 360/anonymous reviews, skip-level or team-lead sensitive access, and Process/Workflow support for sensitive types -- all explicitly deferred, to be revisited only if a later investigation finds a genuine, evidenced need.
- Trends, score aggregation, cross-person comparison, and rankings -- 12.3.2 is trustworthy longitudinal history, not analytics; a later 12.3.3 trend slice would need its own separate product decision.
- Goals, Performance Cycles, and Check-Ins -- a separate, later slice of People Experience, not part of 12.3.1 or 12.3.2.

## Phase 13 - Audit & Operational Trust

**Status:** Active major direction. Phase 13.1 (Record Change History), Phase 13.2A (Workflow Execution-Log Durability), Phase 13.2B1 (Field + Choice Configuration Audit), and Phase 13.2B2 (EntityType Lifecycle Audit) are complete. The remaining governance families stay future-looking and require separate review.

### Phase 13.1 - Record Change History

**Status:** Complete. Migrations `0110`-`0114` are immutable. Implementation, verification, and dogfood evidence live in `PROJECT_CONTEXT.md`.

This slice delivers append-only, record-context change history for create, update, import, archive, and restore operations, with truthful human, impersonated, Automation, and Process attribution. It deliberately does not create a workspace-wide audit explorer or claim comprehensive historical coverage.

### Phase 13.2A - Workflow Execution-Log Durability

**Status:** Complete. Migration `0115` is immutable. Workflow execution logs retain the originating Workflow UUID as a historical soft ID and snapshot the Workflow name, trigger EntityType name, trigger type, watched fields, conditions, and ordered action context. `action_results` remains the authoritative execution outcome. Workflow hard deletion no longer deletes execution logs, and the existing log surface falls back to the snapshotted Automation name when the live Workflow is absent. Governance/configuration audit coverage is partially delivered by the separately reviewed 13.2B1 and 13.2B2 slices; a Workspace Audit Explorer remains future-looking.

### Phase 13.2B1 - Field + Choice Configuration Audit

**Status:** Complete. Migration `0116` is immutable. The append-only `governance_audit_events` store covers semantic Field create/meaningful grouped update/archive/restore/safe-delete events and Choice create/label-update/archive/restore events. Choice color-only and reorder-only noise is deliberately excluded. Existing `schema.manage` and impersonation boundaries remain intact, service-role fixture/bootstrap writes do not fabricate history, Field archive/restore uses authorized RPCs, and hard-deleted Field history survives through soft subject references. Dedicated live verification passed 1/1; focused backend regressions passed 30/30; the focused impersonation authority suite passed 16/16; focused UI smoke passed 4/4; static checks passed with 0 lint errors and 3 pre-existing warnings. EntityType audit and remaining governance families remain future-looking and require separate review.

### Phase 13.2B2 - EntityType Lifecycle Audit

**Status:** Complete. Migrations `0117`-`0120` are immutable. EntityType create, onboarding, grouped metadata update, archive, restore, and safe delete use authoritative audited boundaries. Direct RLS-protected metadata updates are captured by one narrow trigger; raw slug UPDATE is revoked; archive/restore remain RPC-only; and the private creation helper suppresses only the initial display-field setup update. Dedicated live verification passed 3/3; focused backend regressions passed 37/37; focused E2E smoke passed 24/24; impersonation passed 16/16; static checks passed with 0 lint errors and 3 pre-existing warnings. Remaining governance families and Workspace Audit Explorer remain future-looking.

### Phase 13.2B3a - Workflow Governance Audit

**Status:** Complete. Migration `0121` is immutable. Trigger-based Workflow governance captures semantic create, grouped update, enable, disable, and explicit delete events while preserving the existing authenticated direct-DML `automation.manage` boundary. Bounded snapshots retain trigger EntityType, watched Field, condition, ordered action, and referenced configuration labels; structural cascades do not fabricate user-level delete history; and Workflow execution logs remain separate. Dedicated live verification passed 1/1; focused governance and impersonation regressions passed 20/20; focused Workflow E2E passed 1/1 after an isolated browser network-flake rerun; static checks passed with 0 lint errors and 3 pre-existing warnings.

### Phase 13.2B3b - Process Template Governance Audit

**Status:** Complete. Migration `0122` is immutable. Process Template create, one-event-per-save grouped updates, archive, restore, and successful safe delete are captured at the outer authorized RPC boundaries using bounded normalized template, EntityType, node, and route snapshots. Safe delete now requires `automation.manage`; Process Run, Workflow `start_process`, and EntityType dependency blockers remain intact; runtime history remains separate; service-role fixture behavior and real-actor impersonation semantics remain unchanged. Dedicated live verification passed 2/2; focused governance/Process regressions passed 22/22; focused Process Template E2E passed 7/7; focused Process runtime and Workflow dependency E2E passed 29/29; static checks passed with 0 lint errors and 3 pre-existing warnings. Remaining governance families and Workspace Audit Explorer remain future-looking.

### Governance, Audit & Workspace Hygiene

Design constraints:

- Keep authentication/workspace membership (`auth.users`/`workspace_memberships`) separate from configurable business data -- never turn `workspace_memberships` itself into an extensible business-object table.
- Prefer explicit, reversible, non-destructive lifecycle transitions (explicit link/unlink over silent replacement; designation blocked rather than auto-cleared while links or active sensitive/lifecycle configurations exist) over inventing new migration/reinterpretation semantics.
- Do not silently turn manager/team visibility scope (`private.managed_user_ids`) into mutation authority -- carried forward unchanged from Phase 11, and honored throughout 12.3.1/12.3.2.
- Any future people-sensitive visibility or write mechanism must be evaluated against the risk of "creating an over-general policy engine prematurely" before being approved.

## Later Strategic Capabilities

These areas are important, but should be sequenced after Phases 8F-10 unless a concrete product need pulls a smaller slice forward.

### Personal Settings & Preferences

- User settings foundation separate from workspace-wide configuration and administrator controls.
- Appearance/theme, including any future dark-mode support.
- User timezone and date/time formatting preferences.
- Notification preferences, channel toggles, digests, and due-soon thresholds.
- Default landing page or navigation preferences such as favorites, pins, or recents.
- Density and accessibility preferences where they materially improve everyday work.

### Governance, Audit & Workspace Hygiene

- Workspace Health V2: pending deactivated-assignee findings, additional deterministic structural checks, and better fix workflows; extend checks only when they are explainable and directly actionable.
- Recurring hygiene policies for stale records, missing ownership, stuck processes, orphaned relationships, inactive owners, possible duplicates, and configurable archive rules.
- Preview/review paths for any hygiene action that could alter or hide data.
- General workspace activity/audit explorer, including imports, workflow execution, process failures, administrative changes, richer actor/effective-actor history, and support/impersonation events.
- Impersonation/support-mode evolution: effective-user-aware UI gating, effective-user-aware notifications, reason capture, optional read-only support access, and stronger production support traceability.
- Hardening of remaining raw/schema mutation paths where retained `SECURITY INVOKER` behavior can bypass app-layer validation.
- Further governance/configuration audit coverage beyond 13.2B2, including Workflow/Process Template, roles/organization, and people-sensitive governance, remains future-looking and requires separate review.
- Row-scoped visibility, team-based record visibility, ownership, and possibly multi-role membership if the permission model needs them.

### Process, Automation & Notifications

- Process reminders, escalations, delegation, and manager/team alerts. (Self-reassignment and administrative reassignment both shipped in Phase 11 -- see above.)
- Dynamic assignment from origin fields, roles, teams, expressions, round-robin, groups, or workload rules.
- Process skip, reopen, and rework -- Reopen and rework are explicitly rejected, not merely deferred (see Phase 11's investigation, above); Cancel shipped in Phase 11.1.
- Richer Process graph manipulation where usage justifies it: drag-to-position, drag-to-connect, layout persistence, and safer branch/region movement.
- Additional Process node types such as subprocesses or carefully bounded external/action nodes.
- Better workflow observability, durable background execution, more actions/conditions, and an explicit `unset` sentinel for transition conditions.
- Business calendars, holidays, SLA-style due calculations, and timezone-aware analytics/reporting.

### Data, Views & Search Beyond Phase 9

- Alternate saved-view modes such as Kanban, calendar, gallery, or dashboards when the table foundation is strong.
- Advanced search across workflows, views, settings, archived records, comments, and files.
- Fuzzy or indexed search only if real scale or query patterns require it.
- Schema-from-CSV, multi-object import, relation matching improvements, and background import jobs if synchronous flows stop being sufficient.
- Configurable record-field sections for create/edit/detail surfaces: named sections per business object, explicit section order, explicit field order within each section, and sensible handling of ungrouped fields. Section placement is presentation metadata only; moving a field between sections must not change field identity, field key, stored record data, API representation, automation/process references, or underlying schema semantics. Table and saved-view column configuration remains independent. Defer drag-and-drop page-layout designers, arbitrary grid/canvas layouts, role/persona-specific layouts, reusable layout templates, Salesforce-style page-layout machinery, and collapsible sections unless later justified.

### Production & Platform Readiness

- Self-serve workspace creation/signup, profile management, and workspace administration flows beyond invitations.
- Separate/local Supabase test environment and CI-ready test isolation.
- Deployment hardening, environment management, monitoring, backups, and operational runbooks.
- Retention and cleanup policies for notifications, events, imports, and other operational logs.
- Workspace seat provisioning/entitlements: a workspace provisioned for a fixed seat count, with admins able to see seats used vs. available; invitations and reactivation should respect the seat limit at the authoritative backend boundary, not just in the UI. Keep seat entitlement separate from roles/capabilities — seats govern whether a user can occupy the workspace, roles govern what they can do once there. Deactivation frees a seat; no destructive deletion introduced merely to manage seats.
- Forgotten-password recovery: a secure "Forgot password?" flow from sign-in, built on Supabase Auth's own supported password-reset primitives rather than a bespoke token system, with safe redirect/session handling and standard short-lived reset semantics.
- MFA/2FA: user-facing multi-factor authentication via Supabase Auth's supported MFA capabilities. Optional per-user MFA is the likely first step; workspace-enforced MFA policy can follow later if enterprise needs justify it. No custom TOTP/recovery-secret infrastructure unless the auth provider can't support the required behavior.

### AI-Assisted Configuration

Longer term, Kinema should reduce setup cost by helping users generate deterministic configuration from natural language or examples.

Potential direction:

- Propose business objects, fields, relationships, select options, roles, teams, process templates, due rules, automations, views, and permissions from a user's description of their operation.
- Let users review, edit, diff, and approve proposed configuration before anything is created.
- Reuse the same validators, dependency checks, and safe lifecycle rules as manual configuration.
- Treat AI as the expert system builder, not as an unbounded executor of everyday work.

## Explicit Non-Goals For Now

- Do not build a generic project-management clone at the expense of configurable operational structure.
- Do not add a huge integration marketplace before the API/webhook/provider foundations are clear.
- Do not introduce destructive cleanup automation without administrator review, auditability, and clear rollback or preview semantics.
- Do not hand routine process execution to AI. Deterministic automation and Process execution remain the product's job.
- Do not broaden roadmap phases just because adjacent ideas exist. Each phase should ship coherent, usable product value.
