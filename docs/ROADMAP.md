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

**Status:** In progress. 11.1 (Cancel Process Run) and 11.2 (Reassign Active Human Work) are both complete -- migrations `0092`/`0093`/`0094`, implementation and verification detail live in `PROJECT_CONTEXT.md`. 11.3 (Runtime Intervention Authorization) is the active next roadmap focus and the only remaining slice of this phase.

**Goal:** Let authorized users safely handle two common real-world exceptions in an active Process Run -- abandoning a run and changing who owns active human work -- without mutating the Process Template, reversing completed history, or weakening deterministic runtime guarantees.

This phase followed a dedicated investigation (current-state findings, runtime invariants, and a capability-by-capability assessment covering reassignment, cancellation, skip, reopen, send-back/rework, delegation, escalation, and manager/team intervention) that recommended a small, contained slice sequence over either a full workflow-engine expansion or deferring the whole area. Reopen and arbitrary send-back/rework were explicitly rejected during that investigation, not merely deferred: every completion path in the Process runtime is provably forward-only and write-once, with no reverse-transition precedent anywhere in the codebase's migration history, and reopening/reworking would require reversing already-cascaded routing/join/side-effect state that has no existing mechanism to undo.

Delivered scope (11.1, 11.2):

- Cancel Process Run (11.1): a `cancelled` status on both `ProcessRun` and `ProcessStepRun`, distinct from `completed`/`skipped` (cancellation is a different historical fact from routing determining a step was not taken, and is never represented as `skipped`). Every active/pending StepRun transitions to `cancelled`; every already-completed/skipped StepRun and its routing/approval/comment/input-request history is preserved exactly. Requires a reason (enforced at both the RPC and the database layer), records impersonation-aware actor/effective-actor attribution, emits a best-effort Activity event, and frees the origin record for an immediate new run. Gated on the existing `processes.operate` capability only -- no new capability was added.
- Reassign Active Human Work (11.2): the current assignee of an active `human_task`/`approval` StepRun can hand it to another current workspace member -- self-service only; administrative reassignment of someone else's step is deferred to 11.3. A new `assignment_generation` counter gives every handoff its own distinct episode, so notification dedup keys can tell a fresh episode apart from a prior one: generation 1 keeps the exact pre-existing unsuffixed keys (preserving already-delivered notification history untouched), generation 2 and beyond use generation-suffixed keys, guaranteeing a reassigned user reliably gets correct assignment/due-soon/overdue notifications rather than silently receiving none. `due_at` is preserved exactly, never recalculated. A `step_reassigned` Activity event records each transition with frozen from/to labels and actor/effective-actor attribution. Gated on the existing `processes.operate` capability only -- no new capability was added.

Planned scope (11.3 -- not yet built):

- Runtime Intervention Authorization: resolve self-reassignment vs. administrative reassignment vs. cancellation authority using the existing `processes.operate` capability and impersonation semantics -- no new capability unless the existing vocabulary genuinely cannot express the needed boundary.

Explicitly out of scope for this phase (rejected or deferred, not simply unstarted):

- Manual Skip, Reopen, and arbitrary send-back/rework -- see the rejection reasoning above.
- Runtime graph rewiring, dynamic assignment, timed delegation, and escalation/reminder policy beyond what 11.2 already needed to keep reassignment notifications correct.
- Deadline reset on reassignment -- 11.2 preserves `due_at` unconditionally; no option to recalculate it was added or is planned.

Design constraints:

- Preserve deterministic execution and immutable routing history -- a runtime intervention may only affect currently active/pending state, never a step that has already completed or was already routed around.
- Prefer new durable events over reinterpreting or rewriting historical rows, matching this project's established pattern for `routing_result`, `decided_by_*`, and now `cancelled_at`/`cancellation_reason`.
- Do not silently turn manager/team visibility scope (`private.managed_user_ids`) into mutation authority.

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
- Field-level record-change and relation-change history.
- General workspace activity/audit explorer, including imports, workflow execution, process failures, administrative changes, richer actor/effective-actor history, and support/impersonation events.
- Impersonation/support-mode evolution: effective-user-aware UI gating, effective-user-aware notifications, reason capture, optional read-only support access, and stronger production support traceability.
- Hardening of remaining raw/schema mutation paths where retained `SECURITY INVOKER` behavior can bypass app-layer validation.
- Durable workflow log preservation; deleting a workflow should eventually not erase meaningful execution history.
- Row-scoped visibility, team-based record visibility, ownership, and possibly multi-role membership if the permission model needs them.

### Process, Automation & Notifications

- Process reminders, escalations, delegation, and manager/team alerts. (Self-reassignment shipped in Phase 11.2; administrative reassignment is active Phase 11.3 -- see above.)
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
