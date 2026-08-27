# Project Context

This document is durable handoff context for a fresh Codex coding session. It describes the current implementation, not the full chat history.

## Product Purpose

This project is an early vertical slice of a flexible business operations platform. The eventual product should let users define their own operational systems: entity types such as Client, Employee, Project, Deliverable, Task; fields on those entities; relationships between records; records themselves; and deterministic automations around those records.

The product direction is deliberately metadata-driven. The UI should be generic enough that a newly configured entity immediately works with the same record form, table, relation controls, and workflow machinery without adding entity-specific React components.

Core product/design principles established so far:

- Make the system easy to configure, but reluctant to let users accidentally make data inconsistent.
- Prefer explicit, reversible lifecycle states before destructive operations.
- Do not silently rewrite, null, cascade, or delete dependent data.
- Preserve immutable internal identities even when user-facing names change.
- Favor deterministic software behavior. Longer term, AI should help users configure this deterministic system through natural language; AI should not become the routine executor of ordinary operations that the product itself can perform reliably.
- Keep the UI understandable and specific, while keeping the underlying implementation generic.

## Tech Stack

- TypeScript
- Next.js 16.3.1 with the App Router and React 19
- Supabase/Postgres for persistence
- `@supabase/supabase-js` from server-side code
- No ORM
- Node requirement: `>=24 <25`
- Styling is simple app CSS/Tailwind-compatible setup; no UI component framework
- Playwright Test for E2E tests

Normal server-side Supabase access is centralized in `lib/supabase/server.ts`. It reads:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`

The separate server-only `lib/supabase/admin.ts` reads `SUPABASE_SECRET_KEY` and is reserved for E2E fixtures/bootstrap administration. Normal application runtime uses request-scoped authenticated Supabase clients with the publishable key; RLS is the tenant-security boundary.

Useful npm commands:

```bash
npm run dev
npm run lint
npx tsc --noEmit
npm run build -- --webpack
npm run test:e2e
npm run test:e2e:ui
```

Use the webpack build form. The standard verification sequence must be run sequentially:

```bash
npm run lint
npx tsc --noEmit
npm run build -- --webpack
npm run test:e2e
```

Do not run typecheck and build concurrently; they can race over `.next` generated types.

## Domain Model

The canonical TypeScript domain types are in `lib/domain/types.ts`.

`Workspace` is the top-level tenant boundary. Authenticated users receive access only through explicit `workspace_memberships`; repository calls keep `workspaceId` explicit. The validated `active_workspace_id` cookie is UI convenience state, never authorization.

Phase 7A roles and capabilities:

- Every membership has exactly one same-workspace `workspace_role`. Existing memberships received a broad built-in compatibility role during migration; custom roles use the same tables and capability vocabulary.
- Workspace membership continues to grant workspace-wide **read** visibility in 7A. Capability IDs gate interactive mutation/configuration; role names are descriptive only and never authority.
- Supported capability IDs are `schema.manage`, `automation.manage`, `records.operate`, `processes.operate`, `operations.view`, `workspace.manage_settings`, `workspace.manage_members`, `workspace.manage_roles`, and `workspace.manage_organization`.
- The authoritative checks are RLS and hardened authorized RPCs. `getWorkspacePermissionContext`/`requireWorkspaceCapability` provide server-action and UI convenience only.
- `schema.manage` covers entity/field/schema/display configuration; `automation.manage` covers workflow and Process Template configuration; `records.operate` covers record, relation, and saved-view writes; `processes.operate` covers interactive run starts, human completion, approval decisions, and action-step retry operations. Member/role administration and organization structure are separately capability-gated.
- Role assignment, role editing, and role deletion-with-reassignment are atomic, workspace-advisory-serialized RPCs. They validate the proposed final workspace state, reject self-escalation/cross-workspace IDs/unknown capabilities, and preserve at least one membership whose role has both member and role management capabilities. Ordinary members still cannot enumerate raw `workspace_memberships` rows; the management UI uses narrow authorized role/member listing RPCs.
- Trusted system-owned workflow/process execution remains separate from interactive checks: service-role execution can use the canonical automation paths, while interactive callers cannot invoke scheduler/dispatcher system paths arbitrarily.

Phase 7B teams and reporting:

- `workspace.manage_organization` gates all organizational mutations. Existing roles that already had both member- and role-management capabilities received it during migration; newly created custom roles may include it through the same canonical capability vocabulary.
- Teams are flat workspace-scoped metadata. A member may belong to multiple teams; a team may have multiple leads. Leads are organizational facts only and never confer permissions.
- Each member may have zero or one direct primary manager. Manager assignment is workspace-advisory-serialized and rejects self-reporting, foreign workspace IDs, and reporting cycles, including concurrent changes.
- Raw organization tables are unavailable to `authenticated`. Hardened authorized RPCs perform management writes and scoped read helpers reveal only management data to organization managers, or a member's own teams, manager, direct reports, and team peers where relevant. Raw `workspace_memberships` remains self-only.
- Archiving a team blocks new members/leads; hard deletion requires an empty team. Removing a workspace membership cascades only its current team, lead, and reporting relationships. Organization edits never change roles or capabilities, and do not affect My Work, record visibility, or system automation.

`EntityType` represents a user-defined kind of record. It has `id`, `workspaceId`, `name`, `slug`, optional `description`, optional `displayFieldDefinitionId`, optional `archivedAt`, and ISO 8601 UTC `createdAt`/`updatedAt` strings. Entity IDs are stable; names, slugs, and display-field configuration are user-facing metadata.

`FieldDefinition` represents a field on an entity. Supported field types are:

- `text`
- `number`
- `date`
- `boolean`
- `relation`

Each field has an immutable `key`, unique within the workspace. Record JSON values are keyed by this `key`, not by mutable display name or slug. This lets users rename fields without migrating stored primitive values. `FieldDefinition.id` is used for relational/config references such as workflows and relation rows. `relatedEntityTypeId` is present only for relation fields. Fields also have `required`, `position`, optional `archivedAt`, and ISO timestamps.

`EntityRecord` represents one record of an entity. Primitive field values are stored in `entity_records.values` JSONB under immutable field keys. Relation values are persisted in `entity_record_relation_values`, not only as JSON strings. Repository reads merge relation target record IDs back into `EntityRecord.values[field.key]` so generic forms/tables can treat records uniformly.

`FieldValue` is `string | number | boolean | null`. Dates are stored as `YYYY-MM-DD` strings. All timestamp fields are ISO 8601 UTC strings.

Record display labels are centralized in `lib/domain/record-repository.ts`: use a configured active text display field when present, otherwise the first active text field by position, otherwise a shortened record ID. If the configured display-field value is empty, labels fall back directly to the shortened record ID. Archived target records can still display with an `(Archived)` suffix where needed.

Workspace record search is centralized in the same repository. It searches active text fields on active records in active entities, groups results by entity, and uses the centralized label resolver for every result.

Workspace onboarding and Home:

- A workspace is new only when it has zero entity types, including archived entities. An archived-only workspace remains established and never re-enters onboarding.
- New workspaces receive a two-step Home setup flow. Users can select Clients, Projects, Tasks, and/or Sales / Opportunities, review the resulting metadata and inferred direct relations, then create everything atomically. “Start from scratch” opens the existing entity-definition form and creates no template metadata.
- Starter structures are ordinary editable metadata, not persistent product modes. Relations are added only when both selected endpoints exist: `Project.Client`, `Task.Project`, and `Opportunity.Client`.
- Established Home is operational: entity cards are primary and show their active record count, Open and Add shortcuts, and capped saved-view links. The Add shortcut targets the existing `#add-record` form.
- Workspace navigation prioritizes Home, Search, and active entities. Workflows, Create entity, and archived-entity management live under the secondary Workspace setup disclosure. Active entity pages are records/views/add-record first; schema and lifecycle controls are available through explicit `?manage=true` mode.
- Operational UX Polish keeps the established workspace table-first: compact record/view controls precede the records table, Add Record is an inline native disclosure rather than a persistent form, and empty entity/view states explain whether the entity has no records or the selected view has no matches. No new record route, modal, domain capability, or persistence model was added.

`EntityView` represents a saved table view for one entity. Saved views live in `entity_views` with `name`, `position`, `isDefault`, JSONB filters/sorts/column field IDs, and ISO timestamps. They configure table presentation only; they do not copy schema or records.

## Data Integrity And Lifecycle Rules

Workspace boundaries are enforced structurally throughout the schema using workspace-scoped foreign keys and composite constraints. Relation rows carry source and target entity IDs explicitly so Postgres can prove:

- source record belongs to the source entity
- field definition belongs to that same source entity
- relation field declares the target entity
- target record belongs to the target entity
- all rows belong to the same workspace

Records:

- `entity_records.archived_at` implements archive/restore.
- Active record tables exclude archived records by default.
- Archived records do not appear as new relation dropdown options.
- Existing relationships to archived records remain valid and displayable.
- When editing a record that already references an archived target, that archived target remains selectable as the current value so unrelated edits are not destructive.
- Hard deletion is blocked if any incoming relation references the target record, or if any Process Run (any status) originated from it. If unreferenced, deletion removes the record; source-side relation rows cascade through existing constraints/RPC behavior.

Entities:

- `entity_types.archived_at` implements archive/restore.
- Archived entities are hidden from normal navigation/selectors by default.
- Direct entity URLs remain viewable, but archived entities are read-only except restore/safe delete actions.
- Entity rename updates user-facing name/slug while preserving entity ID.
- Hard deletion is allowed only when the entity has zero records, including archived records; no field in the workspace has `related_entity_type_id` equal to that entity ID (self-relations count and block deletion); no workflow's `create_record` action still targets that entity; and no Process Template (active or archived) applies to it. The workflow check has no FK backing it (the entity-target relationship lives inside `actions[]` JSONB, not a column) — it is an explicit application-level `EXISTS` scan inside `delete_entity_type_if_safe`, deliberately blocking rather than cascading, matching the field-deletion dependency pattern below. The process-template check *is* additionally backed by a structural FK (`process_templates.applies_to_entity_type_id ... on delete restrict`), since that relationship lives in a real column, not JSONB.

Fields:

- `field_definitions.archived_at` implements archive/restore.
- Normal metadata reads exclude archived fields by default. Use `includeArchivedFields: true` only for management, workflow repair/execution validation, dependency inspection, and safe preservation paths.
- Archived fields disappear from ordinary record forms, tables, and new workflow configuration.
- Existing workflows and saved views referencing archived fields remain intact but invalid or stale until corrected.
- Hard deletion is safe-only. It is blocked if primitive record JSON contains the field key anywhere, if relation rows exist for the field, if workflow JSON config references the field, if the field is configured as an entity display field, or if saved table-view config references the field.
- Primitive deletion dependency detection treats `values ? field_key` as a dependency even if the stored value is null/empty; no automatic cleanup is performed.

Required field safety:

- Adding a required field to an entity with existing records is rejected.
- Changing optional -> required is handled by RPC validation; every existing record must already have a valid non-null value. Relation fields require a relation row for every record. Violations reject the change with a count.
- Required -> optional is always allowed.

Saved views:

- Every entity has an implicit All Records view.
- Saved views support AND-only filters, typed operators, ordered visible columns, and deterministic sorting with record ID tie-breaks.
- Text contains/not-contains matching is case-insensitive.
- Date values must be valid `YYYY-MM-DD` strings.
- At most one saved view per entity can be the default view.
- Stale column/sort references are surfaced as warnings; stale filter references fail closed.
- Deleting a view never deletes records.
- Workspace Home uses entity base links for primary navigation, preserving configured default-view behavior. Its secondary shortcuts use `?view=all` and `?view=<view-id>` routes.
- Entity pages keep All Records and saved-view switching visible, while saved-view creation, editing, default selection, and deletion live under an explicit native Manage views disclosure. Stale-reference warnings still open and fail closed as before.

Workspace search:

- `GET /search?q=...` performs a case-insensitive trimmed substring search across active text fields on active records in active entities.
- Results are grouped by entity, capped at 20 records per entity, and link to record detail pages.
- For each entity, display-field matches rank before other text-field matches; prefix matches rank before general substring matches; remaining ties use label then record ID.
- A match outside the display field can show concise matching-field context. Search is deliberately limited to records: no fuzzy matching, pagination, workflow/view/settings search, or database search index in v1.

Record details and reverse relationships:

- Stable detail route: `/entities/[entityTypeId]/records/[recordId]`.
- Detail pages show active fields in schema order, human-readable primitive formatting, outgoing relation links, lifecycle actions, and derived incoming relationships.
- Detail pages are identity-led: Edit is the primary action, while archive/restore/delete remain available through a secondary native Record actions disclosure. Details and Related Records retain their generic metadata-driven behavior.
- Archived records remain directly viewable, show archived state, and can be restored or safely deleted.
- Incoming/reverse relationships are derived from existing relation rows and metadata. They are not stored separately.
- Reverse relationship groups exclude archived source records, archived relation fields, and archived source entities.
- Active incoming relation fields produce a reverse group even when it has no records, so users can create the first related record.
- A reverse group can open the source entity's normal create form with its specific relation field prefilled to the current active record. The prefilled relation remains editable; successful creation and Cancel return to the originating detail page through validated origin entity/record IDs, never an arbitrary return URL.

Faster Record Work — inline primitive-field editing:

- The entity records table (`entity-records-table.tsx`) supports inline, click-to-edit editing of `text`, `number`, `date`, and `boolean` fields directly from the table, via a new `updateRecordField` server action in `app/actions.ts` and a `EditableTableCell`/`EditableCellForm` client component pair in `app/components/editable-table-cell.tsx`.
- Relation fields and the identity/display field remain read-only inline in v1; they keep their existing badge/link rendering. Archived records and archived entities disable inline editing entirely (same `recordEditPathBase` gate the Edit link already uses).
- Interaction model is consistent across all four supported types: an explicit click/button opens edit mode; Enter or an explicit Save control commits; Escape cancels and returns focus to the triggering cell control; blur outside the cell's own form also cancels — it never silently saves. Boolean fields use the same explicit-commit model (toggle the checkbox, then Enter/Save), not autosave-on-click.
- After a successful save, the page calls `router.refresh()` to re-render from the server; there is no optimistic client-side record state in v1.
- Because `update_entity_record_with_relations` replaces the entire primitive `values` object rather than patching one key, `updateRecordField` always merges the edited value into the full current active-field value snapshot before validating and writing — it reuses `validateRecordFormData` and `updateEntityRecordInRepository` unchanged, so required-field validation is identical to the full edit form.
- A no-op inline edit (submitted value equal to the persisted value, via the same `valuesAreEqual` equality used for watched-field change detection) short-circuits before the repository write and before workflow execution — no DB write, no `record_updated` workflow event.
- A real inline edit follows the exact same previous-snapshot/write/reload-next-snapshot/`getChangedFieldDefinitionIds`/`executeRecordUpdatedWorkflows` sequence as `updateRecord`, so `changed`/`changed_from`/`changed_to`/`changed_from_to` and watched-field semantics behave identically whether the edit came from the full Edit form or an inline cell.
- If validation fails on the edited field, the cell stays in edit mode with an inline field-level error. If a save is blocked by a different (typically hidden, view-filtered-out) field on the record, the cell shows a concise fallback ("This record needs additional changes. Open full edit.") linking to the full Edit route, rather than reproducing full-record validation inside the table.
- No migration, repository, RLS, or domain-model change was required — the feature is additive at the server-action and UI layer only.

## Workflow System

Workflow domain types are in `lib/domain/workflow-types.ts`; validation is in `lib/domain/workflow-validation.ts`; execution is in `lib/domain/workflow-engine.ts`; persistence is in `lib/domain/workflow-repository.ts`.

Implemented trigger types:

- `record_created`
- `record_updated`

Implemented action types (per step; see "Multiple ordered actions" below):

- `create_record`
- `update_record`
- `update_related_record`
- `start_process`

Workflows are stored in `workflows` with `trigger_type`, `trigger_entity_type_id`, an ordered JSONB `actions` array (at least one element, enforced by a `jsonb_array_length >= 1` CHECK constraint), and a narrowed JSONB `action_config` holding only workflow-level `triggerConfig`/`conditions`. Each element of `actions` is one step: `{ actionType, actionTargetEntityTypeId?, relatedFieldDefinitionId?, processTemplateId?, fieldMappings }`. `create_record` requires `actionTargetEntityTypeId`; `update_record` targets the triggering record; `update_related_record` targets the current record reached through that step's own `relatedFieldDefinitionId`; `start_process` requires only an active compatible `processTemplateId` and always uses the original triggering record as its ProcessRun origin. The legacy top-level `action_type`/`action_target_entity_type_id` columns no longer exist (see Database And Migrations).

Conditions:

- Stored in `conditions`, at the workflow level — not per action.
- Empty conditions means always run.
- Conditions are AND-only.
- Supported operators include equality/inequality, numeric comparisons, date before/after, `is_set`/`is_not_set`, and (record_updated only) `changed`, `changed_from`, `changed_to`, `changed_from_to`.
- At execution time, all condition configuration is fully validated before evaluation. Broken config logs `failed`; non-matching valid conditions log `skipped` with “Workflow conditions did not match.”
- Conditions evaluate against the triggering record snapshot for that workflow event, exactly once, before any action runs. No action — including one that modifies the field a condition matched on — causes conditions to be re-evaluated.

Record-updated watched fields:

- Stored in `triggerConfig.watchedFieldDefinitionIds`, at the workflow level — not per action.
- A `record_updated` workflow must watch at least one field.
- ANY watched field changing qualifies.
- Invalid or archived watched fields log `failed`.
- If watched fields did not change, execution logs `skipped` with “Watched fields did not change.”

Transition-aware conditions (`changed`, `changed_from`, `changed_to`, `changed_from_to`):

- `record_updated` only; `record_created` workflows never expose or accept them (rejected server-side even if crafted directly, not just hidden in the editor).
- Compare the field's previous persisted value against its current persisted value from the same original user-edit event that `app/actions.ts`'s `updateRecord` already loads to compute watched-field changes. No new persistence: previous values are never stored in `action_config` or execution logs, only carried in memory for that one execution.
- `changed` needs no operand. `changed_to`/`changed_from` need one operand (`value`/`previousValue` respectively). `changed_from_to` needs both, and they must differ.
- Every transition operator requires the field to have genuinely transitioned (`previous !== current`); `changed_to`/`changed_from_to` do not fire merely because the field already held the target value.
- `0`, `false`, and `""` are real, distinct values, never treated as unset; only null/undefined collapse together (same equality rule already used for watched-field change detection, reused directly).
- Relation operands compare record IDs; the editor shows human-readable labels via the same active-record dropdown used for relation equality conditions.
- **Watched-field invariant:** a transition operator's `sourceFieldDefinitionId` must also be in `triggerConfig.watchedFieldDefinitionIds`, or the workflow cannot be saved (“`<field>` must be a watched field to use a changed condition on it.”). This is enforced in the one shared `validateWorkflowConditions` function used at both save time and execution time, so execution never relies on editor behavior alone. The editor auto-checks a field as watched when a transition operator is selected for it, but does not prevent unchecking a still-referenced watched field afterward — that combination fails save validation with a clear inline message instead.
- v1 limitation: from/to operands must be concrete typed values; there is no “unset” sentinel. A transition from/to an unset value cannot be expressed directly. Combining `changed` with `is_set`/`is_not_set` approximates it but is not equivalent (it does not guarantee the *previous* value was specifically unset).

Field mappings (per action step):

- `unset` is available for optional target fields in `create_record`.
- `leave_unchanged` and `clear` are available for `update_record` and `update_related_record`.
- `constant` stores a type-appropriate literal.
- `source_field` copies a direct field from the trigger record.
- `template` is available for text targets only.

Compatibility is strict: text -> text, number -> number, date -> date, boolean -> boolean, and relation -> relation only when both fields target the same related entity. No implicit coercion, no relation traversal, no dynamic lookups.

Templates:

- Persist canonical placeholders as `{{field:<field-definition-id>}}`.
- The UI shows human-readable placeholders using disambiguated entity-qualified labels so duplicate field names can round-trip without exposing UUIDs.
- Execution formatting is deterministic: text plain string, number `String(value)`, date stored `YYYY-MM-DD`, boolean `Yes`/`No`, relation display label, missing optional value empty string.

Relation handling in workflows:

- Constant relation mappings can select active records only.
- Source relation values may come from existing archived relationships, but creating a new relation to an archived target is rejected.
- Direct relation placeholders render the related record display label.

Execution semantics:

- Enabled workflows execute in deterministic order: `created_at ASC, id ASC`.
- Each matching workflow executes independently. Failure of one workflow does not prevent later workflows from running, and the original triggering record remains created/updated.
- Workflow-generated record creation or updates do not recursively trigger workflows.
- Eligibility/watch-field detection/conditions are based on the original persisted triggering event, and are evaluated exactly once, before the first action runs — never per action, never re-checked after an action executes.
- `update_record` and `create_record` actions both reload the latest authoritative triggering record before resolving mappings/templates, so a later action sees an earlier action's committed effects rather than the original triggering snapshot. (`create_record`'s reload was added in this milestone — with only ever one action per workflow previously, the original triggering snapshot and "latest" were always identical, so the gap was invisible until multiple actions could run in sequence.)
- `update_record` modifies only explicitly configured fields, preserving unrelated active and archived primitive values and unrelated relation rows.
- A valid no-op `update_record` logs `succeeded` with result message “No changes required.” and does not perform an unnecessary DB update or bump `entity_records.updated_at`.
- `update_related_record` follows exactly one active direct relation field on the latest triggering record, then reloads and updates that one related record using the same mapping, compatibility, validation, atomic RPC, no-op, and no-recursion rules as `update_record`.
- `update_related_record` configurations require at least one mapping other than `leave_unchanged`. Missing relations, archived selected relation fields, archived target entities/records, and archived mapped fields fail execution. If a related target is resolved before a later failure, its entity/record IDs are retained in the execution log.
- `start_process` is available on both record-created and record-updated workflows. It has no mappings, target selector, or relation traversal: it calls the existing `startProcessRun` repository operation with the active workspace, configured template, triggering entity, and original triggering record. The canonical membership-checked RPC therefore remains the sole owner of template/origin validation, graph traversal, snapshots, assignee/due-rule handling, advisory locking, and the one-active-run rule. An active duplicate run fails the action rather than silently no-oping.

Multiple ordered actions:

- A workflow's `actions` array is executed strictly in configured order, sequentially (`for...of`, awaited) — no parallelism, no branching, no delays/scheduling.
- The first action to fail stops the remaining actions in that workflow run. Actions that already completed keep their committed writes — there is no cross-action rollback of the workflow run, and the original triggering event is never rolled back.
- A later workflow (in the deterministic `created_at ASC, id ASC` order) still runs even if an earlier workflow's action sequence failed partway through.
- Workflow-driven writes still bypass the normal user-edit action layer entirely (they call the record repository directly), so they still cannot recursively trigger workflows — true for every action in the sequence, not just the first.
- The editor (`app/components/workflow-create-form.tsx`) supports Add Action, Remove Action (minimum one action enforced both client-side and server-side), and Move Up/Move Down for reordering; there is no drag-and-drop. Per-action form field names are namespaced by a client-generated action id (`mappingType:<actionId>:<targetFieldId>`, etc.) so two actions can target the same field without colliding.
- Submitted action ids must be unique; a duplicate is rejected server-side with a clear `_form` validation error before any per-action parsing that keys off action id, so a duplicate can never silently collapse two submitted actions into one persisted action.

Execution logs:

- Stored in `workflow_execution_logs`.
- Status is `succeeded`, `failed`, or `skipped` — this is the whole-workflow-run status, not a per-action status.
- Logs include trigger entity/record, timestamps, error/result messages, legacy `created_record_id`/`action_entity_type_id`/`action_record_id`, and a structured `action_results` JSONB array.
- `action_results` holds one ordered entry per action that actually began execution (never an entry for an action skipped because an earlier one failed first), each with `index`, `actionType`, `status` (`succeeded`/`failed`), and — where applicable — `actionEntityTypeId`, `actionRecordId`, `createdRecordId`, `processTemplateId`, `processRunId`, `originEntityTypeId`, `originRecordId`, `resultMessage`, `errorMessage`. Process-specific fields preserve traceability without overloading the legacy record-action fields.
- Legacy singular fields (`createdRecordId`/`actionEntityTypeId`/`actionRecordId`) keep their original single-action meaning for a workflow with exactly one action. For a workflow with more than one action they are `null` on a fully successful run (no single action to point at without being misleading) and describe the *failed* action on a failed run (a genuinely resolved, non-arbitrary target) — `action_results` is authoritative in both cases, especially for multi-action runs.
- The top-level `errorMessage` for a multi-action failure is prefixed with which action failed, e.g. `"Action 2 (update_related_record) failed: ..."`; a single-action workflow's error message is unprefixed, exactly as before this milestone.
- `resultMessage` for a multi-action success summarizes each action's outcome (`"Action 1: ... Action 2: ..."`); a single-action workflow's result message is unprefixed, exactly as before (e.g. still exactly `"No changes required."` for a single-action no-op).
- The workflow execution log UI (`app/workflows/page.tsx`) renders the `action_results` breakdown beneath the existing summary line only when there is more than one entry, so single-action and legacy logs render exactly as they did before this milestone.
- Action entity/record log fields intentionally do not have FKs so audit/history semantics are not undermined by future hard deletes.
- Deleting a workflow currently cascades its execution logs. This is acceptable for the prototype; audit preservation may change later.

## Process System

The first foundation for a reusable human-process orchestration engine, deliberately distinct from the other three subsystems: Entities are business data, Views are ways of seeing records, Workflows are event-driven automation ("when X happens, do Y"), Processes are repeatable sequences of human/operational work ("to accomplish X, these steps need to happen"). Domain types are in `lib/domain/process-types.ts`; persistence is in `lib/domain/process-repository.ts`; form-shape validation is in `lib/domain/process-validation.ts`; server actions are in `app/process-actions.ts` (a separate file from `app/actions.ts`, kept out of that already-large file).

Persistence model — edge-driven and graph-capable, supporting linear paths, approvals, timer waits, condition/event waits, conditional branching, and structured parallel regions:

- `ProcessTemplate` (`process_templates`): `name`, optional `description`, immutable `appliesToEntityTypeId` (set once at creation, never editable), `archivedAt`-only lifecycle (matching `EntityType`/`FieldDefinition`, not the `workflows.enabled` boolean pattern — a template creates durable historical dependents the way records do, unlike workflows).
- `ProcessNode` (`process_nodes`): one step definition, `nodeType` (`'human_task'`, `'approval'`, `'wait'`, `'condition_wait'`, `'parallel_split'`, or `'parallel_join'`), `name`, and a JSONB configuration source. Human tasks and approvals may carry assignment/due configuration; a timer wait has a snapshotted `waitRule`; a condition wait has a snapshotted `conditionWaitRule`; neither has an assignee or due rule. Parallel system nodes carry a `parallelGroupId`, no assignee, and no due rule. Node IDs are stable across ordinary template edits.
- `ProcessEdge` (`process_edges`): a real ordered adjacency table (`sourceNodeId` -> `targetNodeId`), not a position column on nodes. It records default/conditional routing, parallel branches, or a stable approval outcome UUID plus label. Approval outcome labels are nonblank and unique per approval after trim/case-folding; distinct outcomes may intentionally target the same step. Canonical validation enforces the supported graph shape rather than attempting to repair malformed direct data.
- `ProcessRun` (`process_runs`): one started instance, `status` (`active`/`completed`), `originEntityTypeId`/`originRecordId`, and a **snapshot** of `processTemplateName`/`processTemplateDescription` taken at start time — a later template rename never rewrites a run's historical display. `processTemplateId` is retained for traceability/dependency checks only.
- `ProcessStepRun` (`process_step_runs`): one instantiated step, fully snapshotting `nodeType`/`name`/`config` from its node at start time, plus persisted optional `dueAt` and `resumeAt`, `status` (`pending`/`active`/`completed`/`skipped`), `parallelGroupId`, optional branch token, and a stable `stepIndex`. A completed approval additionally snapshots its selected outcome ID/label and decision time/actor ID/actor email separately from its routing history. `sourceNodeId` is a soft reference (no FK), matching the existing `workflow_execution_logs` precedent of not FK-constraining audit fields — a step run's correctness never depends on its originating node still existing.

Template editing preserves node identity: `save_process_template_authorized` updates existing `process_nodes` rows in place for steps resubmitted by ID (rename/reorder/config edits never change the ID), inserts new rows for null-ID steps, deletes rows omitted from the submission, and always fully rebuilds `process_edges` from the final submitted order (edges have no independent identity or history value to preserve). Submitted existing node IDs are validated server-side to actually belong to the same workspace/template.

Process-run lifecycle:

- The canonical start operation (`start_process_run_authorized`) is shared by manual record-detail starts and workflow `start_process` actions. It validates the template/origin, serializes on a per-origin-record advisory lock, rejects a second concurrent active run, creates all StepRuns, and snapshots every template edge into immutable `process_step_run_routes` rows between those StepRuns. It deterministically selects the sole validated start node; `0032` corrects a PostgreSQL `min(uuid)` defect in the already-applied `0031` function, while `0031` itself is corrected for clean bootstrap.
- A template + origin record combination may have unlimited *historical* runs, but at most one *active* run at a time — once a run completes, starting another is allowed and record detail offers "Start another run."
- Generic completion (`complete_process_step_run_authorized`) accepts active `human_task` StepRuns only. An approval is decided only by `decide_process_approval_authorized`: an assigned approval requires its snapshot assignee; an unassigned approval is decidable by any same-workspace member. A timer `wait` is never manually completable: it becomes active with one persisted UTC `resumeAt`, then the trusted scheduler resumes it through the narrow service-only batch RPC. A `condition_wait` is also never manually completable: it snapshots its condition configuration at run start, evaluates live current origin or direct-related record values, and advances only when the condition becomes true through the service-only wakeup dispatcher. An approval selects exactly one edge from the run-scoped outcome snapshot, records a separate decision snapshot plus an `approval_outcome` routing result, and leaves the approval active on failure. Ordinary/conditional human-task and wait sources select one route: ordered AND-only conditions evaluate against current origin-record values, then the first match or exactly one default wins. A parallel split instead creates one immutable join obligation per branch token and activates every selected branch. A join auto-completes only after every expected token arrives, then activates its downstream route exactly once. Conditional, approval, and wait routing inside one branch are token-local, so skipped alternatives never block sibling work or the matching join. Routing updates are serialized per process run with an advisory lock; evaluation errors are atomic, leaving the current step active with no partial routing write.
- Process runs never write to `entity_records`; workflow-triggered starts call the process RPC directly and do not recursively trigger workflows.

UI: `/processes` (list), `/processes/new`, `/processes/[processTemplateId]/edit` (the step editor — Add approval/Move Up/Move Down/Remove, no drag-and-drop, no canvas) live under the "Workspace setup" navigation disclosure next to Workflows. `/process-runs/[processRunId]` is a flat top-level route (not nested under the origin entity) showing the ordered step list: active human tasks expose Complete, while active approvals expose their named decision actions and completed approvals show their recorded decision. Record detail shows a concise "Processes" section per applicable template: not-started shows Start process; an active run shows progress/current step and Open process (no duplicate Start); a completed-with-no-active-run state shows the last completion and Start another run. **Starting a process redirects immediately to its `/process-runs/[id]` page** rather than staying on record detail — worth knowing when writing E2E flows that need to return to record detail afterward.

Security model: all nine process tables, including immutable `process_step_run_routes`, `process_parallel_join_obligations`, `process_condition_wait_dependencies`, and `process_condition_wait_wakeups`, are RLS-enabled and grant **select-only** to `authenticated` — there is no raw authenticated insert/update/delete path on any of them, unlike the older entity/workflow tables' incrementally-tightened grants. Every ordinary write goes through a membership-checked, fixed-search-path `SECURITY DEFINER` `_authorized` RPC from the start (`save_process_template_authorized`, `archive_/restore_process_template_authorized`, `delete_process_template_if_safe_authorized`, `start_process_run_authorized`, `complete_process_step_run_authorized`, `decide_process_approval_authorized`), and `workspace_id` is immutable on all nine tables via the same `private.reject_workspace_id_change()` trigger every other workspace-scoped table uses. `resume_due_process_waits_system` and `dispatch_process_condition_wait_wakeups_system` are the only trusted scheduler/dispatcher exceptions: both are fixed-search-path, service-role-only, and have PUBLIC, anon, and authenticated EXECUTE revoked. The protected internal `POST /api/internal/process-waits` route checks `PROCESS_WAIT_SCHEDULER_SECRET` and invokes only these narrow batch RPCs; it accepts no workspace/run authority from callers. Approval decision execution is granted only to `authenticated`/`service_role`; both PUBLIC and explicit `anon` execution are revoked.

Safe-delete integration: `delete_entity_type_if_safe`/`delete_entity_record_if_unreferenced` (and their `_authorized` wrappers) were extended with a `process_template_count`/`process_run_count` column respectively (required a drop+recreate, matching how migration 0020 handled the same return-shape change) — an entity type cannot be hard-deleted while any process template (active or archived) applies to it, and a record cannot be hard-deleted while any process run (any status) originates from it. `delete_process_template_if_safe_authorized` also blocks hard deletion while either ProcessRun history or any workflow `start_process` action references the template, returning both dependency counts for friendly messaging. Archiving remains allowed and does not rewrite workflow config; an archived referenced template simply fails execution until restored. Process templates/runs/step-runs are never cascade-deleted when their business object is deleted — deletion is blocked, not cascaded, same philosophy as the relation-field and workflow-target checks.

Fixed step assignment + My Work (migration `0028_process_step_assignment.sql`):

- Each `human_task` or `approval` `ProcessNode` may have `assigneeUserId` — none, or exactly one current workspace member. `process_nodes` carries a composite FK `(workspace_id, assignee_user_id) -> workspace_memberships(workspace_id, user_id)`, no cascade. This one constraint structurally guarantees an assignee is always a member of the *same* workspace, and blocks removing that membership (or deleting the underlying `auth.users` row, which cascades into `workspace_memberships`) while any template node — including nodes on an archived template — still assigns them. There is still no membership-removal product feature; this hardens whatever removal path eventually ships.
- `process_step_runs` carries a parallel `assigneeUserId` (soft, no FK — matching the existing `sourceNodeId` precedent) plus a snapshotted `assigneeLabel` (the assignee's email at the moment the run started). Historical step runs render entirely from this snapshot; they never require the membership row to still exist, and they never block membership removal on their own — only a live `process_nodes` reference does.
- Human-readable identity is deliberately minimal: a single new RPC, `list_workspace_member_identities_authorized(workspace_id)`, membership-checked, `security definer`, `set search_path = ''`, with every reference to `auth.users`/`public.workspace_memberships` fully schema-qualified. It returns only `{user_id, email}` for the requesting member's own workspace — no other `auth.users` metadata, no profile table, no denormalized column on `workspace_memberships`. Assignment always resolves the *current* email live (template editor, run detail for an in-progress step); `process_step_runs.assigneeLabel` is the one place email is ever persisted, and only as a point-in-time snapshot.
- `save_process_template_authorized` validates a submitted `assignee_user_id` is a current workspace member before writing (friendly error; the composite FK is the structural backstop) and updates it in place for resubmitted steps — same identity-preserving semantics as name.
- `start_process_run_authorized` copies each node's `assignee_user_id` and resolves its current email into `assignee_label` at that exact moment — a later template reassignment never rewrites an already-started run's step.
- `complete_process_step_run_authorized` is now assignee-aware: an assigned active step may only be completed by `auth.uid() = assignee_user_id`; an unassigned active step remains open to any authenticated same-workspace member. This is the sole enforcement point — `ProcessRunDetailView` additionally hides the Complete action for non-assignees, but only as a UX nicety on top of the RPC check, never instead of it.
- "My Work" (`/my-work`, primary nav, not under Workspace setup) is a read-only convenience filter, not a new visibility boundary — any workspace member could already see any process run via `/process-runs/[id]` regardless of assignment. `listMyWorkItems` in `process-repository.ts` derives the current user exclusively from `getCurrentUser()` server-side (never a client-submitted ID), and splits into "Ready now" (`status = 'active'`) and "Upcoming" (`status = 'pending'`) sections, both scoped to `assignee_user_id = <current user>` and joined to only `process_runs.status = 'active'` — a completed run's steps disappear from My Work entirely. The origin record's label is resolved live (not snapshotted — unlike the run/template name, the origin record is a live business object, not history).

Process Due Dates + Attention (migration `0029_process_step_due_dates.sql`):

- A human-task or approval node may configure no rule or `{ amount: 1..8760, unit: 'hours' | 'days' }` in `config.due_rule`; one day always means exactly 24 elapsed hours. The template editor exposes this as optional `Due [amount] [Hours|Days] after activation`. TypeScript and the canonical `save_process_template_authorized` RPC reject zero, negatives, fractions, unsupported units, malformed config, and values above 8760; failed saves are transactional.
- Every StepRun snapshots this configuration at run start. Only active steps receive a persisted `due_at`: start calculates the first deadline from one activation timestamp, and completion atomically calculates the next step's deadline from that pending StepRun's snapshot. Pending steps intentionally retain `due_at = null`; live `process_nodes` timing configuration is never read during an already-started run.
- `overdue` is strictly derived, never stored: an assigned StepRun is operationally overdue only while `status = 'active'`, `due_at is not null`, and `due_at < now()`. Completion keeps `started_at`, `due_at`, and `completed_at` history but removes the step from operational overdue work.
- My Work now groups the current user's active-run assignments as Overdue, Ready now, and Upcoming. Active due-dated work sorts by `due_at` ascending, then undated active work by stable run/step order; pending work has no fabricated deadline and retains deterministic run/step ordering.
- Process Run and record-detail process summaries show compact due context only where present. Timestamps are stored as UTC `timestamptz` and rendered as browser-local absolute date/times after hydration; there is deliberately no user/workspace timezone setting or relative-calendar wording in v1.
- No scheduler, queue, email, or notification subsystem exists. This milestone intentionally sends no reminders; a later delivery increment needs scheduled execution, a delivery channel, idempotency/delivery history, retry policy, and timezone policy.

Process Graph 5C.2 — Wait States (migration `0037_process_wait_states.sql`):

- A `wait` is an active system StepRun with no assignee or due rule. It is never shown in My Work and generic completion rejects it. Pending and skipped waits keep `resume_at = null`; activation calculates and persists it once; completed waits retain `started_at`, `resume_at`, and `completed_at` history.
- Supported snapshotted rules are elapsed hours, calendar days in an explicit IANA timezone, Monday-Friday weekday durations (activation date does not count), and calendar targets: first through twentieth weekday of next month, first selected day of week next month, or one specific zoned date/time. Hours are pure UTC elapsed time; calendar rules preserve local wall-clock time and persist the resulting instant as UTC. Holidays/business calendars are deliberately deferred.
- The scheduler is provider-neutral. A deployment cron invokes the secret-protected internal route, which uses the admin client only to call service-role-only `resume_due_process_waits_system`. The batch scans active due waits in deterministic bounded order, uses `FOR UPDATE SKIP LOCKED` plus the existing per-ProcessRun advisory lock, rechecks state under lock, and treats already-resolved waits as harmless no-ops. A failing wait rolls back its own advancement and remains durable/retryable without corrupting other due waits.
- Wait completion uses immutable run-scoped routes and current authoritative origin values for any outgoing conditions. It preserves a parallel branch token, records exactly one join arrival, and activates downstream human/approval work with their existing assignment/due semantics. Manual and workflow-triggered starts snapshot waits identically; live template edits do not change an activated wait's `resume_at` or an existing run's route/config snapshot.

Process Graph 6A — Visual Process Builder Foundation (no migration; UI/state-layer only):

- `app/components/process-template-form.tsx` now offers a List/Graph toggle inside the existing template editor route (`/processes/new`, `/processes/[processTemplateId]/edit`) rather than a separate page. Both views render from one shared client-side `steps` state; there is no second data model, no separate save path, and no persisted layout — switching views never loses in-progress edits.
- The per-node-type editing fields (wait configuration, condition-wait configuration, assignee/due, approval outcomes, conditional routing) were extracted from the List view into shared components in `app/components/process-node-editor.tsx` (`ProcessNodeEditor` and its sub-fields), so List rows and the Graph side panel render and mutate state through identical controls — there is exactly one implementation of each editing control, not two that could drift.
- Graph view (`app/components/process-graph-view.tsx`) renders every node (`human_task`, `approval`, `wait`, `condition_wait`, `parallel_split`, `parallel_join`) as a distinctly labeled card and every route as an SVG edge, labeled with its condition summary, approval outcome, or "Otherwise" for the default route. Conditional branching is edge/route behavior, not a node type — there is no separate "branch" node. Selecting a node (click, or Enter/Space when focused, each card is a real `<button>`) opens a side panel with that node's full `ProcessNodeEditor`; Escape deselects. Reordering remains List-only in 6A — the Graph panel does not offer Move Up/Down.
- Layout (`app/components/process-graph-layout.ts`) is computed fresh on every render, never persisted: each step's rank is its position in the already-topologically-ordered `steps` array (routes only ever target a later step), and lanes are single-column except inside a parallel split/join region, where each branch gets its own lane via a bounded walk from the split to its matching join. This was sufficient for both reconvergent conditional branches (which need no special handling — multiple edges into one node render correctly with plain rank ordering) and parallel fan-out/rejoin; a graph layout library was deliberately not added.
- Known cosmetic limitation, deferred as future polish: an edge whose target is not the immediately-next step (for example one approval outcome among several skipping over another outcome's target) can render its line/label passing behind an intervening node card. This does not affect data correctness or the panel's editing behavior.
- Fixed alongside 6A verification (pre-existing, unrelated to the graph work itself): `app/processes/[processTemplateId]/edit/page.tsx` never reconstructed a `condition_wait` node's saved `conditionWaitRule` (target kind, relation, entity type, conditions) into the edit form's initial state, so reopening an existing condition-wait step for editing silently showed it with zero conditions. Both List and Graph read from the same corrected initial state, so both now load a saved condition wait's target, conditions, operators, and values correctly.
- Deferred beyond 6A: freeform node positioning/drag-to-move, drag-to-connect/rewire edges, layout persistence, process-*run* (instance) graph visualization, and any visual polish beyond this usable foundation.

Process Graph 6B — Direct Graph Editing (no migration; UI/state-layer only):

- The Graph view (6A) gained direct-manipulation editing while keeping the same governing rule: every gesture is sugar over the existing `steps`/`routes` array model, never a second state shape, and array order remains the sole topological-ordering authority.
- **Insert-on-edge**: a "+" control on every rendered edge opens a type picker (human task / approval / wait / condition wait — not split/join, which still only comes from "+ Add parallel paths" since a region has structural invariants a single splice can't express) and splices a new node into that edge: the clicked route's target is repointed to the new node, and the new node gets a fresh route to the edge's old target. This is uniform across plain, conditional, approval-outcome, and parallel-branch edges — only the clicked route's target pointer changes.
- **Delete**: a delete affix on each node card (and the panel's Remove button) triggers an explicit choice, not a silent rewire, whenever the node is unambiguous (exactly one inbound route from anywhere, and its own routes are exactly one plain default route): "Delete and reconnect '{from}' to '{to}'" (primary) versus "Delete without reconnecting." Ambiguous nodes (approvals, split/join, anything with zero or multiple in/out routes) delete immediately with no invented rewire, identical to the List view's existing Remove behavior.
- **Reorder**: Up/Down buttons on each node card call the same adjacent-swap `moveStep` the List view already used, now guarded on both views by `canSwapAdjacent`: a swap is disabled whenever the step at the lower position has a route directly targeting the step at the higher position (proven correct by construction — no other route can be broken by an adjacent swap), with the reason surfaced via `title`. The RPC remains the authoritative backstop; this is UX safety layered on top, not a new validation source. True pixel/pointer drag was deliberately not built — button-based reorder gets most of the "feels visual" value with far less engineering/testing surface, and it doubles as the mandatory keyboard-accessible path a future drag implementation would need anyway.
- **Edge-routing readability**: fixed the known non-adjacent occlusion issue with a bounded, deterministic technique — an edge whose target isn't the very next rank in the same lane now jogs through a fixed side gutter column (clear of every node card by construction) instead of drawing straight through occupied space. This changes only edge *path* computation in `process-graph-layout.ts`; rank/lane assignment is unchanged. Concurrent gutter edges sharing the same column can still overlap each other — a known, deliberately deferred cosmetic gap, not attempted further to avoid the layout work expanding into general obstacle-avoidance infrastructure.
- **Route navigation**: clicking an edge's label selects its source node and highlights/scrolls to that specific route inside the shared panel (`RoutesEditor`/`ApprovalOutcomesEditor` via a new `highlightRouteId` prop), so "edit this route" is one click instead of hunting through a node's routes.
- Explicitly deferred, per the approved plan: freeform x/y drag positioning, drag-to-wire edge creation, moving a node across branches or into/out of a parallel region (still only via delete+recreate), general crossing-minimization layout, and undo/redo.
- Fixed alongside verification (pre-existing, unrelated to the direct-editing work itself): `lib/domain/process-validation.ts`'s wait-amount check used `/^[1-9]\\d*$/` — a regex *literal* containing an escaped literal backslash+"d", not a digit class — so it rejected every wait amount unconditionally regardless of value. Corrected to `/^[1-9]\d*$/`. Two further pre-existing, unrelated bugs were found and deliberately left unfixed (flagged instead, matching this project's established practice for incidental discoveries): (1) typing/clearing/any-interaction with the rendered Wait Amount input crashes the page client-side (`Cannot read properties of null (reading 'value')`), reproduced identically against the pre-6A component, so it predates both 6A and 6B; (2) a "duration" wait snapshotted with unit `hours` always carries a timezone in its saved config (the form parser unconditionally re-defaults an empty `waitTimeZone` back to `"America/Toronto"`), which the RPC then correctly rejects with "Elapsed-hour waits cannot specify a timezone" — meaning saving *any* hours-duration wait has never actually worked via the UI, independent of the amount-regex bug. `calendar_days`-unit waits are unaffected (they legitimately carry a timezone) and were used to route around this in the new regression test.

Wait UI Bug Fixes (post-6B; a small bug-fix pass, not a milestone; no migration):

- Fixed the client-side crash: every field in `WaitConfigFields` read `event.currentTarget.value` *inside* the deferred `updateStep` state-updater callback, not synchronously in the `onChange` handler. React Strict Mode double-invokes that updater, and by the second invocation the SyntheticEvent's `currentTarget` has already been nulled out (a documented React constraint — `currentTarget` is only valid for the synchronous duration of the handler). Fixed by capturing each field's value into a local `const` synchronously in `onChange` and referencing that captured value inside the updater instead of the event. Root-caused with a direct diagnostic (not by trial and error): logging inside the actual handler showed the updater running twice with `event.currentTarget === null` both times.
- Fixed the timezone leak: `app/process-actions.ts`'s `getWaitRule` included `timeZone` in a "duration" wait's payload whenever the local form state's `waitTimeZone` was non-empty — but `waitTimeZone` defaults to `"America/Toronto"` and is never cleared when switching to "hours" (the IANA-timezone field is simply hidden for that mode, not reset), so every hours-duration wait silently carried a stale timezone the RPC then rejected ("Elapsed-hour waits cannot specify a timezone"). Fixed by gating inclusion on `unit === "calendar_days"` directly, not on truthiness. `calendar_days`/`weekdays`/`calendar_target` behavior is unchanged.
- Both fixes were verified by reverting each independently (via `git stash`) and confirming the new regression test genuinely fails against the pre-fix code, then passes again restored — not just written and assumed correct.
- The regression test uses real UI interaction throughout (typing into the Amount field, clearing it, selecting the Unit dropdown) rather than writing into the hidden `processSteps` payload, which is how this was worked around before the crash itself was fixed. One deliberate detail: the invalid-amount case clears the field to empty rather than typing "0" — the Amount input's own `min="1" step="1"` HTML5 constraints block a literal "0" or "1.5" at the browser level before the form ever reaches the server action, so those values would test native browser behavior rather than the regex fix; an empty value has no `required` attribute to trip and reaches the server, correctly exercising the actual fix.

Process Graph 6C — Visual Process Run / Execution View (no migration; UI/state-layer only):

- The Process Run detail page (`app/process-runs/[processRunId]/page.tsx` → `ProcessRunDetailView`) gained the same List/Graph toggle pattern as the template editor (6A), **List remains the default view**. Graph is purely additional — a second lens over the exact same already-fetched `ProcessRunWithSteps` data (`steps`, `routes`, `joinObligations`), never a second query and never new runtime semantics: it renders what the run's authoritative snapshot already says happened, nothing more.
- **Reuse, not a parallel implementation**: `computeProcessGraphLayout` (6A/6B) was type-narrowed to a minimal structural interface (`{key, nodeType, parallelGroupId, routes}`) it actually needs — a purely mechanical change verified against `process-graph-builder.spec.ts` before anything else was built, so the template editor's `LocalStep[]` still satisfies it with zero changes. `app/components/process-run-graph-adapter.ts` maps a run's snapshotted steps (sorted by `stepIndex`, which already gives the same "array order = topological rank" property `LocalStep[]` relies on) and routes (already keyed by step-run id, already fixed at run-start time) into that same shape — this is *why* a template edit after a run starts can never affect the run's visualization: the run's own data was already immutable before 6C existed, 6C just had to not accidentally join against the live template anywhere.
- `app/components/process-run-graph-summaries.ts` extracts `statusBadgeClass`, `waitRuleLabel`, `stepSummaryLine`, `routingResultLabel`, and a new `isActionableForViewer` out of the List view's previously-inline logic, so List and Graph share one implementation of every status/summary/decision-history string — verified to change no List-rendered text via the full run/approval/parallel/wait/condition-wait/conditional-branching regression suite.
- `app/components/process-run-graph-view.tsx` is the read-only run graph (no editing, no route changes, no manual state manipulation — explicitly out of scope and not built). Node cards show status as both border color and visible text (Sage/completed, Brass-deep/active, neutral/pending, and a distinct reduced-opacity Chalk treatment with explicit "Skipped" text for skipped) — never color-only. Edges are three-way and deliberately not dash-dependent for the taken/untaken distinction (dashing already carries different meaning in the template graph): a route is undetermined (dashed, neutral) until its source step resolves, then taken routes render solid graphite at full opacity/2.5px and untaken siblings render the same solid stroke at 0.35 opacity — color+opacity+width carries the signal, confirmed by asserting the actual opacity values in the regression test, not just their presence. Approval/conditional decision history and parallel-join progress ("Waiting for N of M branches." → "N of M branches joined.") reuse the identical prose the List view already had, now via the shared summaries module. Waits reuse `ProcessDueAt` verbatim for both `dueAt` and `resumeAt`.
- Per your refinement: `CompleteStepButton`/`ApprovalDecisionButtons` — the existing, sanctioned action components and server actions, not new ones — surface in the Graph side panel via `isActionableForViewer`, checked *per selected step-run*: in a parallel run with multiple active steps, only the one currently selected and satisfying the existing active/human-actionable/authorized rule shows controls, exactly matching what List already allowed.
- A small additive-only extension: `computeProcessGraphLayout` gained optional `nodeWidth`/`nodeHeight`/`rowHeight` (defaulting to the template editor's existing constants, so every existing caller is unaffected) — run cards carry more context (status, assignee, due/wait state) than a template step ever needs, so 6C passes taller dimensions rather than cramming.
- Manually verified end-to-end: built a template (human task → approval with a rejected outcome → skip → parallel split/join) and drove the entire run to completion through the Graph panel alone, confirming every transition — active→completed, the taken/untaken edge contrast, the skip treatment, the join's obligation-count text at both intermediate and final states, and the run's own status flipping to complete — before writing the automated test.

Automated Action Nodes (migrations `0041_process_action_nodes.sql` through `0044_process_action_fk_set_null_fix.sql`):

- A new `action` node type performs one deterministic system action automatically when activated: create record, update the origin record, update a related record, or start a process. It has no assignee, no due rule, never appears in My Work, and never requires manual completion — reusing the *exact* `WorkflowAction`/`WorkflowFieldMapping` shape and `executeSingleAction` executor workflows already use (`lib/domain/workflow-engine.ts`), not a second automation system. Editor config UI (`app/components/workflow-action-config-fields.tsx`) is a new shared component the process template editor consumes; the existing Workflow editor was deliberately left untouched (its action-config JSX remains its own, separately-tested implementation) rather than retrofitted under time pressure — a follow-up worth doing, not done here.
- Runtime shape: an activated `action` step stays `active` and uncascaded in SQL (`private.activate_process_step_run` now excludes it from the parallel/system auto-cascade, exactly like `human_task`/`approval`/`wait` already are) rather than resolving inline. The app layer then executes it via one canonical primitive, `executeAndCompleteActionStep` (`lib/domain/process-repository.ts`), and calls back `complete_process_action_step_authorized` (success, advances through the existing `private.complete_process_step_and_advance` continuation helper with a new `action_succeeded` routing outcome) or `fail_process_action_step_authorized` (failure). Both RPCs take only run/step identity and a result payload — never action config — so a caller can only ever say "execute this active ProcessStepRun," never specify an arbitrary mutation; the config actually executed always comes from the step's own immutable `config.actionConfig` snapshot.
- No new `ProcessStepRunStatus`: a failed execution leaves the step `active` with `action_result.status = 'failed'`, visible in both List and Graph with a distinct "Failed" treatment and a Retry control open to any workspace member (matching action nodes' no-assignee shape); a successful execution's `action_result.status = 'succeeded'` accompanies the ordinary `completed` transition. Retry re-runs the identical canonical executor on that one step — not a separate code path.
- `executeActiveProcessActionSteps` is a bounded (25-pass) per-run activation loop called after every mutation that can activate a step — `startProcessRun`, `completeProcessStepRun`, `decideProcessApproval` — so manual and workflow-triggered runs (both already funnel through these same repository functions) behave identically, and a chain of action nodes or several parallel branches each landing on their own action step all settle before the caller's request returns.
- Full composability: a wait or condition-wait resuming into an action node is supported. `getEntityContext`/`getEntityRecord`/`entityRecordExists`/`createEntityRecord`/`updateEntityRecord`/`startProcessRun`/`getProcessRunWithSteps` all gained an optional injectable `supabase` client (`lib/supabase/server.ts`'s `SupabaseServerClient` type), defaulting to the existing per-request cookie client everywhere it's omitted (zero behavior change for every existing caller). The wait/condition-wait scheduler route (`app/api/internal/process-waits/route.ts`) uses this to drain any action node its own RPCs just activated, via a narrow discovery query (`listActiveProcessActionStepRuns`, identity only) feeding the *same* canonical executor under its admin client — never a separate scheduler-only execution path or a broad service-role mutation surface.
- Idempotency: `entity_records.originating_process_step_run_id` and `process_runs.originating_process_step_run_id` (both nullable, partial-unique-indexed per workspace) are the durable identity a `create_record`/`start_process` action's own step run carries. `create_entity_record_with_relations` and `start_process_run_authorized` check for an existing row/run tagged with that identity before creating one, so a retry after a crash between a successful side effect and its completion record reuses the prior result instead of duplicating it; relation writes are never repeated on the reuse path. Updates need no equivalent — `executeRecordUpdate`'s existing diff-against-current-value check already no-ops a repeated identical update.
- Template-save validation (`private.validate_process_action_node_config`) is deliberately lighter than execution-time validation (which reloads live entity context exactly as workflow actions already do): it only rejects structurally dangling references (missing/archived target entity, relation field, or process template; a `start_process` action cannot target its own template) at save time.
- Safe-delete/lifecycle dependency scanning was extended everywhere the equivalent `workflows.actions[]` scan already existed: field deletion (`delete_field_definition_if_safe`), entity-type deletion (`create_record` targets), and process-template deletion (`start_process` targets) all now also scan `process_nodes.config.action_config`/`process_step_runs.config.action_config` the same way.
- Three real bugs were found and fixed via focused E2E runs against the applied migration, each isolated to its own follow-up migration rather than editing the original: (1) `CREATE OR REPLACE FUNCTION` with an appended parameter does not replace an existing function — Postgres matches by full parameter-type list, so it silently created a second overload, leaving every existing 4-arg caller ambiguous (`0042`); (2) `save_process_template_authorized` only stripped the new `action_config` key from steps it disguised as `human_task`, not from every other step, so an ordinary step's residual `action_config: null` key tripped a pre-existing structural allowlist guard inside the inner save function (`0043`); (3) a composite foreign key's plain `on delete set null` nulls every column in the FK including `workspace_id`, tripping the workspace-immutability trigger — fixed using PostgreSQL 15's column-scoped `on delete set null (...)` (`0044`). A fourth, non-migration regression was also found and fixed: the new `process_runs.originating_process_step_run_id` FK gave PostgREST two relationship paths between `process_runs` and `process_step_runs`, breaking My Work's embedded-select query; fixed by replacing that one embedded select with two plain queries rather than guessing the auto-generated constraint name.

Process Graph 5C.3 — Condition/Event Waits (migrations `0038_process_condition_event_waits.sql` and `0039_process_condition_wait_template_save_fix.sql`):

- A `condition_wait` is an active system StepRun with no assignee, due rule, timer rule, manual completion, or My Work entry. It snapshots `{ target, conditions }` at run start while evaluating the latest authoritative origin record or one direct related record at activation and on relevant future changes.
- `process_condition_wait_dependencies` records the active condition's field and relation-binding dependencies separately from `process_condition_wait_wakeups`, the durable outbox. Narrow triggers on primitive records, relation rows, and field lifecycle enqueue only change metadata. The service-only dispatcher does evaluation and advances through the existing run-scoped graph continuation path; it uses per-ProcessRun advisory serialization and authoritative row locks, closing activation-versus-update lost wakeups without broad workspace locks.
- An already-true condition advances immediately and retains no dependency rows. A false condition remains active with only its current dependencies. A related wait rebinds atomically from A to B when the origin relation changes: dependencies on A are removed, B is registered and evaluated, and later A changes cannot advance the wait. Dependencies are removed whenever the wait resolves or is skipped.
- Direct authenticated record edits and workflow-originated canonical record writes both enqueue wakeups. Repeated wakeups and concurrent dispatcher calls remain exactly-once at the StepRun level; one failing wakeup is isolated and retryable without corrupting unrelated work. Existing run snapshots never read live template configuration, but condition values remain intentionally live.
- Condition waits preserve conditional routing, approval/timer sequencing, branch tokens, one join obligation per branch, and manual/workflow-triggered run-start parity. Unresolved condition-field and relation references participate in the same archive/safe-delete protection pattern as Process Graph 5A; once a wait resolves, its active dependency rows no longer block that dependency path.

## Database And Migrations

Migrations live in `supabase/migrations/` and are currently applied manually through the Supabase SQL Editor. The latest migration is:

- `0054_workspace_teams_and_reporting.sql`

`0019_workflow_multiple_actions.sql` added the ordered `actions` JSONB column (backfilling every pre-existing single-action workflow into a one-element array before enforcing `NOT NULL`/non-empty-array constraints), narrowed `action_config` to `{ triggerConfig, conditions }`, dropped the legacy `action_type`/`action_target_entity_type_id` columns and their constraints/FK, added `action_results` JSONB to `workflow_execution_logs`, and rewrote `delete_field_definition_if_safe` to scan all of `actions[]`. `0020_entity_delete_blocks_create_record_targets.sql` followed up: dropping `action_target_entity_type_id` also removed the composite FK that used to structurally block deleting an entity still targeted by a `create_record` action, so `delete_entity_type_if_safe` was rewritten (drop + recreate, since its `TABLE` return shape gained a column) to explicitly block that case instead.

`0021_auth_workspace_rls.sql` introduced Supabase Auth memberships and RLS for every workspace-scoped table. `0022_workspace_ownership_and_mutation_grants.sql` makes `workspace_id` immutable on every persisted workspace-scoped domain row. `0023_record_mutation_rpc_wrappers.sql` adds membership-checking, fixed-search-path SECURITY DEFINER wrappers for canonical record create/update/delete, allowing raw record/relation writes to be revoked. `0024_entity_create_display_field_grant.sql` restores the narrowly required display-field update permission for the still-SECURITY-INVOKER entity-creation RPC. `0025_authorized_safe_delete_wrappers.sql` revokes PUBLIC execution from privileged wrappers and adds equivalent authorized wrappers for safe entity/field deletion, allowing raw authenticated DELETE to be revoked for both tables. `0026_workspace_onboarding_setup.sql` adds a membership-checked, fixed-search-path SECURITY DEFINER bulk metadata wrapper for atomic first-run setup. It serializes setup attempts with a workspace advisory lock, rejects any workspace that already has an entity (including archived entities), revokes PUBLIC execution, and grants only authenticated/service-role execution.

`0027_process_templates_and_runs.sql` adds the whole Process System (see above): five new tables (`process_templates`, `process_nodes`, `process_edges`, `process_runs`, `process_step_runs`), all RLS-enabled and select-only for `authenticated`; six new membership-checked SECURITY DEFINER RPCs for every write; the `private.reject_workspace_id_change()` immutability trigger applied to all five; and a drop+recreate of `delete_entity_type_if_safe`/`delete_entity_record_if_unreferenced` (plus their `_authorized` wrappers) to add the new `process_template_count`/`process_run_count` dependency columns. This migration exposed a gap in the shared E2E cleanup helper (`tests/e2e/helpers/supabase-test-data.ts`'s `cleanupEntitiesById`): its raw `entity_records`/`entity_types` deletes now need `process_runs`/`process_templates` cleared first, since both carry an `on delete restrict` FK back to entities/records — fixed alongside this migration so any future spec that starts a process against a test entity still cleans up correctly.

`0028_process_step_assignment.sql` adds fixed process-step assignment (see Process System above): `assignee_user_id` on `process_nodes` (composite FK to `workspace_memberships`, no cascade) and `assignee_user_id`/`assignee_label` on `process_step_runs` (soft snapshot, no FK); the new `list_workspace_member_identities_authorized` RPC; and in-place `CREATE OR REPLACE` updates (unchanged signatures, no new grants needed) to `save_process_template_authorized`, `start_process_run_authorized`, and `complete_process_step_run_authorized` for assignment validation, snapshotting, and assignee-only completion authorization.

`0029_process_step_due_dates.sql` adds nullable `process_step_runs.due_at` and an active-assignee due index, then updates the same canonical save/start/complete RPCs. It creates `private.process_due_at_from_config(jsonb, timestamptz)` to centrally validate snapshotted due configuration and calculate elapsed-hour deadlines. Process tables remain RLS-enabled/select-only to authenticated users; all affected functions retain membership checks, fixed search paths, revoked PUBLIC execution, and authenticated/service-role grants.

`0030_workflow_start_process_actions.sql` recreates only `delete_process_template_if_safe_authorized` because its table return shape gains `workflow_count`. It scans every `workflows.actions[]` JSON element for `start_process` references in the same workspace, blocks deletion when either workflow references or run history exist, and reapplies the membership check, fixed search path, revoked PUBLIC execution, and authenticated/service-role grants. Workflow action and execution-log additions are JSONB/TypeScript changes; no new workflow/process table or public RPC was introduced.

`0031_process_conditional_branching.sql` adds stable node positions, ordered/default/conditional template edges, `skipped` StepRuns, `routing_result`, and immutable per-run route snapshots. It validates forward-only connected DAGs and typed process-only branch conditions (including case-insensitive text `contains` / `not_contains`), evaluates against live origin values only at completion, and extends safe field deletion to live and unresolved snapshotted branch references. `0032_process_branching_start_function_fix.sql` replaces the already-applied start RPC to select its sole start node without PostgreSQL's unsupported `min(uuid)` aggregate.

`0033_process_parallel_paths_and_joins.sql` is the canonical clean-bootstrap Process Graph 5B migration. It adds `parallel_split`/`parallel_join` nodes, parallel group and branch-token snapshots, parallel route markers, and select-only `process_parallel_join_obligations`. Canonical template validation permits only explicit, non-nested/non-overlapping split/join regions with at least two branches, and canonical start/complete functions snapshot then execute them with per-run advisory serialization. `0034_process_parallel_system_node_null_config_fix.sql` is corrective for environments that applied the original `0033`: it changes the system-node validation so JSON `null` means no due rule, while a genuinely configured due rule or any assignee remains invalid. It preserves the existing SECURITY DEFINER, fixed-search-path, grants, and RLS posture; the corrected `0033` already includes the same rule for fresh databases.

`0035_process_approval_nodes.sql` is the canonical clean-bootstrap Process Graph 5C.1 migration. It adds approval nodes, stable UUID-backed named outcome edges (including multiple outcomes sharing a target), snapshotted outcome routes, separate approval decision history on `process_step_runs`, and `decide_process_approval_authorized`. It restricts generic completion to human tasks, extends assignment/due/My Work semantics to approvals, and preserves run-scoped graph snapshots through conditional and parallel routing. `0036_process_approval_anon_execute_fix.sql` is corrective for already-applied `0035` environments where Supabase retained an explicit `anon` EXECUTE grant: it explicitly revokes both PUBLIC and `anon`, then grants only authenticated/service-role execution. The corrected `0035` includes the same explicit anon revoke for fresh databases.

`0037_process_wait_states.sql` is the canonical Process Graph 5C.2 migration. It adds `wait` nodes and `process_step_runs.resume_at`, validates structured timer rules, snapshots wait config at run start, calculates a UTC resume timestamp only when a wait activates, and adds the service-role-only `resume_due_process_waits_system` batch RPC. The corresponding protected internal route is scheduler-provider-neutral: an external cron may call `POST /api/internal/process-waits` with `PROCESS_WAIT_SCHEDULER_SECRET`; normal users cannot call the RPC or provide workspace/run authority.

`0038_process_condition_event_waits.sql` is the canonical clean-bootstrap Process Graph 5C.3 migration. It adds `condition_wait` nodes, active dependency and durable wakeup/outbox tables, snapshot/live evaluation, minimal enqueue-only record/relation/field-lifecycle triggers, and the service-role-only `dispatch_process_condition_wait_wakeups_system` RPC. It also routes successful condition waits through the existing graph continuation mechanics and extends unresolved-field safe-delete inspection. `0039_process_condition_wait_template_save_fix.sql` is corrective for already-applied `0038` environments: ordinary template submits serialize absent `condition_wait_rule` as JSON null, so the wrapper removes that additive key before forwarding non-condition nodes to the legacy saver. It also restores the timer scheduler's established `{ result: { resumed, skipped, failed, conditions } }` response contract. `0040_process_condition_wait_workspace_cascade_fix.sql` is corrective for already-applied environments: relation-change triggers retain normal clear/replacement wakeups but skip outbox inserts after a cascading workspace deletion has removed the parent workspace. The corrected `0038` includes all three compatibility behaviors for fresh databases.

`0045_workspace_roles_and_capabilities.sql` adds `workspace_roles`, `workspace_role_capabilities`, and mandatory same-workspace `workspace_memberships.role_id`, backfilling a full compatibility role for existing memberships. `0046_workspace_capability_enforcement.sql` adds the interactive capability helper plus record wrappers and initial role-management RPCs; `0047_process_capability_wrappers.sql` wraps interactive process operations; `0048_metadata_workflow_capability_policies.sql` separates membership reads from capability-gated metadata, view, workflow, and safe-delete writes. `0049_transactional_role_management.sql` replaces row-level lockout guards with workspace-serialized final-state role edit/delete RPCs; `0050_transactional_member_role_assignment_fix.sql` gives assignment the same final-state/self-escalation protections. `0051_workspace_role_management_reads.sql` adds narrow capability-gated member/role UI read models without opening raw membership enumeration. `0052_record_create_wrapper_overload_fix.sql` removes an accidental four-argument record-create wrapper overload, retaining the canonical five-argument defaulted signature used by ordinary callers and process action nodes. `0053_workspace_role_read_model_email_type_fix.sql` corrects the authorized members read-model's `auth.users.email` result cast. The corrected `0046` and `0051` include their fresh-bootstrap fixes; `0052`/`0053` are corrective migrations for already-applied environments.

`0054_workspace_teams_and_reporting.sql` adds the flat organization layer: teams, multiple team memberships, multiple team leads, and one primary reporting relationship per member. It adds `workspace.manage_organization`, backfills it to every existing role with both member/role management capabilities, and includes it in fresh-bootstrap role capability validation. All organization tables are RLS-enabled with no authenticated raw access; hardened, fixed-search-path authorized RPCs cover management and narrow scoped reads. Workspace-level advisory serialization prevents concurrent reporting cycles, membership FK cascades clean current organization relationships, and the existing workspace-ID immutability trigger protects all new workspace-scoped rows.

Authenticated mutation grants are intentionally split, with Phase 7A capability policies layered over the previous RLS tenant boundary:

- Records and relation rows: canonical authorized wrappers for create/update/delete; records retain only direct archive/restore timestamp updates.
- Entity types and field definitions: raw create/update writes remain for the SECURITY INVOKER canonical RPCs, but RLS requires `schema.manage`; safe deletion is wrapper-only and also requires that capability. A technical same-workspace schema manager can still bypass some app-layer validation through permitted raw writes; wrapping those create/update RPCs remains future hardening.
- Entity views: direct writes remain for the existing repository but require `records.operate`. Workflows: direct writes remain for the existing repository but require `automation.manage`. Workflow execution logs allow direct insert only.
- `workspace_memberships` remains self-only select for authenticated users and has no raw authenticated mutation grant. Authorized list/assignment RPCs are the only normal management path.
- Organization tables (`workspace_teams`, team memberships/leads, and reporting relationships) have no raw authenticated access. Authorized management/read RPCs require `workspace.manage_organization` or intentionally scoped membership context.
- Process tables: select-only to `authenticated` from day one, with zero direct write grants ever — every mutation is a membership-checked authorized RPC. This is a stricter posture than every other table above, adopted deliberately for this new subsystem rather than repeating the incremental grant-then-wrap pattern documented for entity types/fields.

Major tables:

- `workspaces`
- `entity_types`
- `field_definitions`
- `entity_records`
- `entity_record_relation_values`
- `entity_views`
- `workflows`
- `workflow_execution_logs`
- `process_templates`
- `process_nodes`
- `process_edges`
- `process_runs`
- `process_step_runs`

Important RPCs/functions:

- `create_entity_type_with_fields` creates an entity and its initial fields atomically.
- `add_field_definition` adds a field, assigns next position with an advisory lock, and rejects required fields when records already exist.
- `create_entity_record_with_relations` atomically creates primitive JSONB values and relation rows.
- `update_entity_record_with_relations` atomically updates primitive values and covered relation fields; omitted relation fields are untouched, covered optional relations can be deliberately cleared.
- `update_field_definition` renames fields and changes required status with transactional required-field validation.
- `set_entity_display_field` sets or clears the configured display field, enforcing active same-entity text fields.
- `set_entity_default_view` sets or clears the default saved table view without a circular entity/view FK.
- `delete_entity_record_if_unreferenced` blocks hard deletion when incoming relation references exist or any process run originates from the record.
- `delete_entity_type_if_safe` blocks hard deletion for entities with records, entities with another field's relation pointing to them, entities still targeted by any workflow's `create_record` action (scans `actions[]` across all workflows in the workspace), or entities a process template (active or archived) applies to. Never modifies or deletes the dependent workflow/template — deletion is blocked, not cascaded.
- `delete_field_definition_if_safe` blocks hard deletion for primitive JSON values, relation rows, workflow JSON references (scanning workflow-level `triggerConfig`/`conditions` plus every action's `relatedFieldDefinitionId`/`fieldMappings` across `actions[]`), display-field configuration, or saved table-view configuration.
- `save_process_template_authorized` atomically creates or replaces a process template's name/description/steps, preserving node IDs for resubmitted steps and rebuilding `process_edges` from the submitted order.
- `start_process_run_authorized` validates an active compatible template/origin record, rejects a duplicate active run, walks the template's node/edge chain, and creates a snapshotted run with its first step active.
- `complete_process_step_run_authorized` atomically completes the active step and activates the next by `stepIndex`, or completes the run if none remains.
- `archive_process_template_authorized`/`restore_process_template_authorized` toggle a template's `archived_at`.
- `list_workspace_member_identities_authorized` returns only `{user_id, email}` for current members of the requesting member's own workspace — the sole source of human-readable assignee identity, used live for the assignee selector and never persisted except as `process_step_runs.assignee_label`.
- `delete_process_template_if_safe_authorized` blocks hard deletion while any process run (any status) references the template.

Important structural constraints include workspace-scoped uniqueness/foreign keys, relation contract constraints, field position > 0, relation target metadata requirements, workflow trigger/action check constraints, and indexes for common workspace/entity/trigger lookups.

Workflow and saved-view references inside JSONB are not protected by relational FKs. Safe field deletion inspects current JSONB references transactionally, but concurrent reference creation during field deletion remains a future hardening concern for multi-user/authenticated operation.

## Application Structure

Important directories/files:

- `app/` contains Next.js routes, Server Components, and Server Actions.
- `app/page.tsx` is the workspace home, with active entity cards and capped saved-view shortcuts.
- `app/search/page.tsx` is the server-rendered workspace record search page.
- `app/actions.ts` is the main server-action layer for entity, field, record, lifecycle, and workflow mutations.
- `app/entities/[entityTypeId]/page.tsx` is the main entity page: metadata, saved views, records, record create form, table, field management, entity settings/lifecycle.
- `app/entities/[entityTypeId]/records/[recordId]/page.tsx` is the record detail page with outgoing and incoming relationship display.
- `app/entities/[entityTypeId]/records/[recordId]/edit/page.tsx` handles metadata-driven record editing.
- `app/entities/new/page.tsx` handles entity creation.
- `app/settings/page.tsx` is the Members and Roles management surface. It fetches only the capability-gated role/member read models; `app/workspace-role-actions.ts` derives the active workspace server-side and calls the atomic management RPCs. `app/components/workspace-role-management.tsx` is the intentionally small management UI.
- `app/workflows/page.tsx`, `app/workflows/new/page.tsx`, and `app/workflows/[workflowId]/edit/page.tsx` handle workflow listing, creation, editing, toggling, deletion, and log display.
- `app/processes/page.tsx`, `app/processes/new/page.tsx`, and `app/processes/[processTemplateId]/edit/page.tsx` handle process template listing, creation, editing, archiving/restoring, and deletion. `app/process-runs/[processRunId]/page.tsx` is the flat process-run detail route. `app/my-work/page.tsx` is the primary-nav "My Work" page. `app/process-actions.ts` holds the process server-action layer, kept separate from `app/actions.ts`.
- `app/components/entity-navigation.tsx` is the shared workspace navigation for Home, My Work, entities, Workflows, Processes, Create Entity, archived-entity management, the capability-gated Members and Roles link, and the compact record-search entry point. My Work is primary navigation (next to Home), not under the "Workspace setup" disclosure.
- `app/components/record-create-form.tsx`, `record-edit-form.tsx`, `record-detail-view.tsx`, and `entity-records-table.tsx` are generic metadata-driven record UI. `entity-records-table.tsx` delegates eligible cells to `editable-table-cell.tsx` for inline text/number/date/boolean editing.
- `app/components/entity-views-panel.tsx` manages saved table views.
- `app/components/workflow-create-form.tsx` is the reusable workflow definition form for create/edit.
- `app/components/process-template-form.tsx` is the process template editor shell (name/description/applies-to, Add/Move Up/Move Down/Remove, and the List/Graph view toggle). `app/components/process-node-editor.tsx` holds the shared per-node-type editing fields (`ProcessNodeEditor` and sub-fields) used by both the List row and the Graph side panel. `app/components/process-graph-view.tsx` renders the Graph view (nodes, edges, selection, side panel); `app/components/process-graph-layout.ts` computes its rank/lane layout; `app/components/process-graph-summaries.ts` formats node/edge summary text. `app/components/process-template-shared.ts` holds the shared local form-state types/helpers (`LocalStep`, `LocalRoute`, etc.) used across all of the above. `app/components/process-section.tsx` is the record-detail "Processes" summary. `app/components/process-run-detail-view.tsx` is the process-run detail page body. `app/components/process-row-actions.tsx`, `start-process-button.tsx`, and `complete-step-button.tsx` are the process lifecycle/action buttons.
- `app/components/field-*` and `entity-*` components handle metadata management.
- `lib/domain/types.ts`, `workflow-types.ts`, and `process-types.ts` define domain shapes.
- `lib/domain/metadata-repository.ts`, `record-repository.ts`, `view-repository.ts`, `workflow-repository.ts`, and `process-repository.ts` encapsulate Supabase access.
- `lib/domain/view-types.ts`, `view-engine.ts`, and `view-validation.ts` own saved-view behavior.
- `lib/domain/record-validation.ts`, `entity-definition-validation.ts`, `field-definition-validation.ts`, `field-edit-validation.ts`, `workflow-validation.ts`, and `process-validation.ts` own authoritative validation/parsing.
- `lib/domain/workflow-engine.ts`, `workflow-conditions.ts`, `workflow-change-detection.ts`, `workflow-template.ts`, and `workflow-field-labels.ts` own workflow behavior.
- `lib/supabase/server.ts` creates the server-only Supabase client.
- `supabase/seed.sql` seeds the demo workspace/client-style starting data.

## Testing

Playwright E2E tests live in `tests/e2e/`.

Current spec files:

- `entity-record.spec.ts`
- `relations.spec.ts`
- `workflows.spec.ts`
- `record-updated-workflows.spec.ts`
- `update-record-workflows.spec.ts`
- `required-field-rpc-safety.spec.ts`
- `required-field-update-rpc-safety.spec.ts`
- `display-field.spec.ts`
- `views.spec.ts`
- `record-detail.spec.ts`
- `update-related-record-workflows.spec.ts`
- `archived-relation-edit.spec.ts`
- `related-create-records.spec.ts`
- `workspace-navigation.spec.ts`
- `workspace-search.spec.ts`
- `dark-mode-contrast.spec.ts`
- `record-updated-transition-conditions.spec.ts`
- `workflow-multiple-actions.spec.ts`
- `workspace-onboarding.spec.ts`
- `operational-ux.spec.ts`
- `inline-record-edit.spec.ts`
- `process-templates.spec.ts`
- `process-runs.spec.ts`
- `process-conditional-branching.spec.ts`
- `process-parallel-paths.spec.ts`
- `process-approvals.spec.ts`
- `process-waits.spec.ts`
- `process-condition-waits.spec.ts`
- `process-graph-builder.spec.ts`
- `workspace-roles.spec.ts`

Shared helpers live in `tests/e2e/helpers/`, especially `supabase-test-data.ts`. E2E data ownership is centralized there. Each run gets a unique `E2E <suffix>` prefix/marker applied to test-created entity names, workflow names, and test record names where naming exists. Cleanup deletes prefixed workflows/entities and dependent records/relations from the current development Supabase project; `cleanupEntitiesById` clears `process_runs`/`process_templates` scoped to those entity types *before* deleting `entity_records`/`entity_types`, since both carry an `on delete restrict` FK back to entities/records (added alongside migration 0027).

`process-runs.spec.ts` introduces one new pattern: a handful of its tests (rejecting a non-active-step completion, a duplicate active run, or a cross-workspace/foreign ID) call the process RPCs directly the way `required-field-*-rpc-safety.spec.ts` does for records — but since every process RPC is a membership-checked SECURITY DEFINER function with no raw unauthenticated twin (by design, see Process System above), those direct calls need a genuinely authenticated Supabase client, not the service-role admin client `createSupabaseTestClient()` provides. The spec signs in as the same disposable `e2e-runner@ops-project.test` user the browser session already uses (see `global-setup.ts`) via `supabase.auth.signInWithPassword`, scoped to that one spec file; it does not persist a session (`persistSession: false`) and needs no separate cleanup since the user itself is created/destroyed per-run by `global-setup.ts`, not by this pattern.

This first E2E setup intentionally uses the development Supabase project with namespaced disposable data. Before CI or broader team use, prefer a separate Supabase test project or local Supabase.

`playwright.config.ts` runs one Chromium worker, starts a production-style server with:

```bash
npm run build -- --webpack && npm run start:e2e
```

The default test URL is `http://localhost:3100`, overridable with `E2E_BASE_URL`. Global setup creates an ordinary authenticated E2E browser session and stores it at the ignored stable path `tests/e2e/.auth/e2e-auth.json`, outside Playwright-managed output directories. The auth/RLS security spec deliberately uses empty storage state. Traces, screenshots, and videos are retained on failure. Tests should prefer accessible selectors and stable user-facing semantics. Avoid brittle CSS selectors and add `data-testid` only when accessible selection is genuinely insufficient.

Current full-suite baseline after Process Graph 5C.2 Wait States (`0037_process_wait_states.sql` applied): **163 tests passing, 0 failures, 0 skipped, 0 retries** in 13.0 minutes. The focused `workflow-start-process.spec.ts` suite (6 tests) covers compatible/archived template editor behavior, strict crafted-action validation, created/updated-trigger starts, canonical run/step/due snapshots, workflow-triggered approval outcome snapshots, ordered-action duplicate failure, structured process logging, archive/restore recovery, and workflow-reference safe deletion. The Auth/RLS security suite (`auth-workspace-security.spec.ts`) has 3 tests covering sign-in/no-access, active-workspace cookie validation, two-user/two-workspace RLS, immutable workspace ownership, raw grant boundaries, authorized wrappers, and cleanup. The onboarding suite (`workspace-onboarding.spec.ts`) has 5 tests covering empty versus archived-only workspace behavior, approved starter schemas/relations, display fields, custom setup, atomic rollback and concurrent setup, authenticated/anonymous/non-member wrapper access, Home shortcuts, secondary setup navigation, and explicit entity management. The operational UX suite (`operational-ux.spec.ts`) has 2 tests covering the table-first entity workspace, intentional record creation, empty states, secondary saved-view configuration, and secondary lifecycle actions. The inline-record-edit suite (`inline-record-edit.spec.ts`) has 9 tests covering text/number/date/boolean inline edit and persistence, invalid-input inline error without persistence, Escape cancellation, identity/relation cells staying read-only inline, archived-record/archived-entity inline-edit disablement, no-op edits not triggering `record_updated` workflows, and a real inline edit firing transition-condition workflow semantics identically to the full edit form.

The `process-templates.spec.ts` suite (5 tests) additionally covers optional hours/days due-rule persistence through the editor. The `process-runs.spec.ts` suite (22 tests) additionally covers elapsed-hours and 24-hour-day calculation, pending `due_at = null`, StepRun rule snapshot stability across a live template edit, completed deadline history, malformed/invalid due-rule rejection with atomic template preservation, browser-local due-date hydration without hydration errors, and My Work Overdue/Ready-now/Upcoming grouping plus dated-before-undated ordering. It retains all prior start/completion, assignment, lifecycle, and direct-RPC security coverage. `process-runs.spec.ts` requires a genuinely authenticated Supabase client (not the service-role admin client) for its direct-RPC rejection tests, and the assignment tests additionally use a second disposable authenticated workspace member created/torn down entirely within this one spec file (see the pattern note above) — see the note above.

`process-conditional-branching.spec.ts` (5 targeted tests) covers edge-driven default and conditional routing, current-origin evaluation, route snapshot isolation from later template edits, atomic archived-field failure/retry, reconvergence, `skipped` state, routing history, unresolved-route field safe-delete protection, My Work split suppression, and backward-route edit rejection. Targeted Process Graph 5A verification also reran `process-runs.spec.ts` (22), `process-templates.spec.ts` (5), and `workflow-start-process.spec.ts` (5); the full-suite baseline remains unchanged until the final gate.

`process-parallel-paths.spec.ts` (7 tests) covers split activation, concurrent branch completion, exactly-once joins, conditional routing inside one parallel branch, branch-local assignee/due snapshots and My Work, select-only join-obligation runtime state, JSON-null system-node configuration, and atomic malformed-template rejection. Process Graph 5B targeted verification also reran `process-templates.spec.ts` (5), `process-conditional-branching.spec.ts` (5), `process-runs.spec.ts` (22), and `workflow-start-process.spec.ts` (5); the subsequent full gate passed at the baseline above.

`process-approvals.spec.ts` (4 targeted tests) covers stable outcome IDs/labels, shared targets, atomic malformed config rejection, run-scoped snapshot isolation from live label/target edits, decision history/routing history, UI decision actions, assignee/unassigned authorization, My Work due visibility for assigned approvals, anon execution denial, and approval routing inside a parallel branch with exactly one arrived join obligation. Targeted Process Graph 5C.1 verification also reran `process-templates.spec.ts` (5), `process-runs.spec.ts` (22), `process-conditional-branching.spec.ts` (5), `process-parallel-paths.spec.ts` (7), and `workflow-start-process.spec.ts` (6); the final full gate passed at the baseline above.

`process-waits.spec.ts` (3 focused tests) covers duration/calendar snapshots and pending `resume_at = null`, protected scheduler-route secret checks, service-only scheduler execution, due-wait one-time advancement, and branch-token/join behavior. Focused Process Graph 5C.2 verification passed `3/3` wait tests plus `49/49` narrow process regressions (`process-templates`, `process-runs`, conditional branching, parallel paths, approvals, and workflow-triggered starts). The full-suite baseline remains unchanged until the 5C.2 final gate.

`process-condition-waits.spec.ts` (4 focused tests) covers already-true immediate advancement with no dependencies, false conditions, irrelevant versus qualifying direct record updates, duplicate dispatcher execution, related-record A-to-B rebinding, a workflow-originated canonical update wakeup, manual-completion rejection, active dependency removal, and service-only dispatcher execution. Focused Process Graph 5C.3 verification reran it `4/4` plus the narrow existing process regressions: `process-runs` (22), `process-templates` (5), conditional branching (5), parallel paths (7), approvals (4), timer waits (3), and workflow-triggered starts (6), all green (`52/52`). The Process Graph 5C.3 full gate then passed: 167 tests passing, 0 failures, 0 skipped, 0 retries.

`process-graph-builder.spec.ts` (3 tests, new for Process Graph 6A) covers the Graph view rendering every node type distinctly while sharing state with the List view, selecting a node opening a pre-filled side panel whose edit persists through the same save action/RPC as the List view, and keyboard selection (Enter to select, Escape to deselect). `process-templates.spec.ts` gained one additional targeted regression test, "reopening a saved condition wait for edit restores its target, field, operator, and value," covering the condition-wait edit-load fix described under Process Graph 6A above; it was verified to genuinely fail against the pre-fix code before being confirmed green against the fix. Targeted Process Graph 6A verification reran `process-templates.spec.ts` (6, including the new regression test) and `process-graph-builder.spec.ts` (3) together, both green, before the final gate. The Process Graph 6A full gate then passed: 171 tests passing, 0 failures, 0 skipped, 0 retries in 13.6 minutes.

`process-graph-builder.spec.ts` gained 3 more tests for Process Graph 6B: insert-on-edge splicing a node between two existing steps and persisting on save; deleting an unambiguous node offering the reconnect-vs-not choice (and confirming ambiguous nodes still delete without a prompt); and the reorder guard blocking an unsafe adjacent swap in both List and Graph, with the concise reason visible, while a genuinely safe swap between never-connected steps stays enabled. `process-templates.spec.ts` gained one more targeted regression test at the time (initially working around the then-unfixed input crash and timezone bug by writing into the hidden `processSteps` payload). Targeted Process Graph 6B verification reran `process-waits.spec.ts` (3), `process-graph-builder.spec.ts` (6, including the three new tests), and `process-templates.spec.ts` (7, including the new regression test) together, all green, before the final gate. The Process Graph 6B full gate then passed: 175 tests passing, 0 failures, 0 skipped, 0 retries in 15.0 minutes. (An initial full-gate run flagged one failure in the unrelated `record-updated-transition-conditions.spec.ts` — a navigation-visibility timeout under transient system load; all 9 of that file's tests, including the one that failed, passed cleanly in isolation, and the full suite was rerun clean to confirm before recording this baseline.)

The Wait UI Bug Fixes pass rewrote that same `process-templates.spec.ts` test, now titled "typing into the Wait Amount field does not crash the page, an invalid amount still rejects, and a valid hours wait now saves with no timezone," to use real UI interaction throughout instead of the hidden-payload workaround: it types into the Amount field, clears it (verifying no crash and a `pageerror` listener stays empty for the whole test), submits with an empty amount and confirms the same rejection message as before, then saves a valid amount on the default "hours" unit and confirms via direct query that the persisted config carries no `time_zone` key, and separately switches the Unit select to `calendar_days` and confirms that config still legitimately carries one — covering both fixes and proving `calendar_days` behavior is unchanged. Test count is unchanged (one test rewritten, not added). Targeted verification reran `process-waits.spec.ts` (3), `process-graph-builder.spec.ts` (6), and `process-templates.spec.ts` (7) together, all green. The Wait UI Bug Fixes full gate then passed: **175 tests passing, 0 failures, 0 skipped, 0 retries** in 18.6 minutes. (Two transient, unrelated flakes surfaced across the first two full-gate attempts — a `global-setup.ts` sign-in timeout, and a stale-data locator collision in `process-runs.spec.ts` — each confirmed as a flake by an isolated rerun passing cleanly, before a fully clean run recorded this baseline.)

`process-run-graph.spec.ts` (1 comprehensive test, new for Process Graph 6C) drives an entire run — human task, an approval with a rejected outcome (proving the skipped branch and the taken/untaken route contrast), and a parallel split/join — to completion using only the Graph panel's Complete/Reject controls, asserting node `aria-label` status text, edge `data-taken` state and relative `stroke-opacity`, join obligation-count text at both an intermediate and the final state, the skipped node exposing no completion control, and that switching back to List shows the identical terminal counts. The mechanical `computeProcessGraphLayout` type-narrowing was verified in isolation first: rerunning `process-graph-builder.spec.ts` (6) alone before any runtime code was written, confirming zero call-site impact. Targeted Process Graph 6C verification then reran that same file plus `process-run-graph.spec.ts`, `process-runs.spec.ts`, `process-templates.spec.ts`, and the approval/parallel/wait/condition-wait/conditional-branching regressions together (59 tests, 58 passed and 1 isolated approval-spec timeout confirmed as a transient flake by a clean rerun). The Process Graph 6C full gate then passed cleanly on the first attempt: **176 tests passing, 0 failures, 0 skipped, 0 retries** in 17.4 minutes, with no flakes on this run.

`process-action-nodes.spec.ts` (2 tests, new for Automated Action Nodes) covers: a `create_record` action executing automatically with no manual click once its preceding human task completes, correctly mapping a field via `source_field` from the origin record, and creating exactly one record tagged with its originating step run's id; and a failed `update_related_record` action staying visible as "Failed" with its error message and a Retry control, then genuinely succeeding on retry after the underlying cause (a missing relation value) is fixed out of band — proving execution always reads the current record, never a stale snapshot. Targeted verification reran the new spec together with `process-graph-builder.spec.ts`, `process-templates.spec.ts`, `process-runs.spec.ts` (including both My Work tests), `process-run-graph.spec.ts`, `process-waits.spec.ts`, and `process-condition-waits.spec.ts` (45 tests) before the final gate, surfacing and fixing the three migration bugs and the My Work PostgREST-embedding regression described above. The Automated Action Nodes full gate then passed cleanly: **178 tests passing, 0 failures, 0 skipped, 0 retries** in 18.7 minutes, with no flakes.

Focused Phase 7A verification after migrations `0045`–`0053` is green: **56 tests passed** across `workspace-roles` (2), `auth-workspace-security` (3), `entity-record` (1), `views` (9), `workflows` (1), `process-templates` (7), `process-action-nodes` (2), `process-runs` (22), `process-approvals` (4), and `workspace-onboarding` (5). `workspace-roles.spec.ts` covers baseline membership reads, raw membership self-only visibility, each interactive capability boundary, authorized role/member reads, custom-role validation, cross-workspace rejection, self-escalation/self-role protections, safe reassignment deletion, concurrent final-state lockout prevention, and the Members/Roles route. It also verifies the record-create wrapper has one PostgREST-resolvable five-argument signature while four-argument callers remain supported by its default origin parameter. E2E fixture helpers now explicitly assign roles to disposable memberships.

The Phase 7A final gate passed cleanly: **180 tests passing, 0 failures, 0 skipped, 0 retries** in 18.9 minutes. The first full-run attempt surfaced two test-only 5-second UI waits while long serial fixture scenarios were still completing a record save or workflow toggle; both actions pass in isolation and their containing specs pass with explicit 15-second mutation waits. No product, RLS, or authorization defect was found. The final clean run exercised all Phase 7A guarantees: membership-based workspace-wide reads; capability-gated record, schema, automation, and human-process mutation; capability-gated member/role administration; self-escalation and last-administrator protections; cross-workspace denial; self-only raw membership visibility; and trusted system automation separate from interactive-user authority.

Focused Phase 7B verification after `0054` is green: **12 tests passed** across `workspace-organization` (3), `workspace-roles` (2), `auth-workspace-security` (3), `process-action-nodes` (2), and the two My Work cases in `process-runs`. It covers capability-gated organization management, PUBLIC/anon denial, multiple memberships/leads without authorization escalation, manager self/cycle/concurrent-cycle rejection, archived/non-empty team lifecycle rules, membership-removal cleanup, scoped versus raw organization reads, foreign IDs, the Workspace Settings Teams/Reporting UI, existing-role capability backfill, role creation with the new capability, baseline RLS, unchanged My Work, and trusted automated actions. An unrelated PostgREST embed ambiguity in active-workspace resolution was found when the new relationship graph was applied; the membership query now names its original workspace FK explicitly.

The Phase 7B final gate passed cleanly: **183 tests passing, 0 failures, 0 skipped, 0 retries** in 18.1 minutes. Three earlier full-load-only failures were test timing issues: valid record save/redirect completion exceeded Playwright's default five-second assertion window in three existing serial workflow helpers. Each passed in isolation and its containing spec; the specific post-submit assertions now use a 15-second timeout. No product, authorization, RLS, or organization defect was found.

During targeted verification for Fixed Process-Step Assignment + My Work, one test-only issue was found and fixed: the "assignee dropdown lists only current members" assertion originally asserted an exact closed option set, which broke because the shared dev workspace already has a real membership (the developer's own account) beyond the two test-controlled members — fixed to assert inclusion of the expected members rather than an exact set, since the dropdown correctly returns *every* current member, not just test-created ones. No product bug. Process Due Dates + Attention had one separate test-only fixture-name collision (two templates in one scenario shared a name), fixed by making the fixture names distinct; no product defect. Its full gate was clean on the first post-targeted run: 138/138 passing, 0 failures, 0 skipped, 0 retries.

## Intentional Limitations

- Email/password Auth only; users are pre-provisioned and explicitly assigned workspace memberships. No signup, invitations, user-profile management, or workspace switching administration UI.
- No workspace switching UI is shown unless a user has multiple memberships. There is no auth/RLS coverage for other clients or integrations beyond the app and targeted E2E harness.
- No ORM.
- No field type changes.
- No relation target changes after field creation.
- No field/entity delete flows that rewrite dependent data.
- No many-to-many relationships.
- No reverse relation editing; reverse relationships are derived lists with a narrow action to create one new source record prelinked to the current record.
- No relation traversal in workflows/templates/conditions or saved views.
- `update_related_record` is limited to one direct relation and one related target record; no arbitrary lookup, reverse traversal, multi-hop traversal, or multi-record update exists.
- No custom record layouts/page builder.
- No comments, attachments, activity feed, or audit UI.
- No Kanban/calendar/gallery saved-view modes.
- No fuzzy/vector search, pagination, advanced filters, or search for workflows, views, or settings.
- No workflow recursion/chaining (still true even with multiple actions per workflow: workflow-generated writes never re-trigger workflow evaluation).
- No branching, parallel actions, loops, or delays/scheduling within a workflow's action sequence — actions execute strictly in configured order.
- No "unset" sentinel for changed_from/changed_to/changed_from_to transition operands; they require concrete typed values.
- No schedules, queues, background workers, integrations, or webhooks.
- No AI configuration UI yet.
- No configurable delete/archive policies.
- Workflow execution is synchronous app-side execution.
- Workflow logs are basic execution records, not a durable audit ledger.
- No deep DB-level JSON-schema validation of individual `workflows.actions[]` elements; the DB only enforces a non-empty array, and per-action shape (action type, target, mappings) is validated entirely at the application layer. Noted as a future hardening candidate.
- Entity/field create/update RPCs remain SECURITY INVOKER, so a technical member can still use retained same-workspace raw create/update grants to bypass app-layer validation. Safe entity/field deletion and record/relation mutation bypasses are closed through authorized wrappers.
- Process Templates support `human_task`, single-person `approval`, timer `wait`, `condition_wait`, and structured parallel system nodes in a forward-only DAG. There is no loop/back-edge, generalized gateway, automated node, subprocess, comments, voting, delegation, or escalation.
- Process-step assignment is fixed (none, or exactly one current workspace member — a real authenticated Kinema user, not a user-defined Team Member entity) with no dynamic/expression/role/round-robin/group assignment, no assignment from an origin-record field, and no reassignment of an already-instantiated running step. Due dates and derived overdue attention exist; reminders, email, and notifications do not.
- Workflow process starts are limited to one configured active template on the original triggering record. There is no related/arbitrary origin, dynamic template selection, parameter mapping, scheduled/delayed start, workflow-driven step completion/cancellation/restart, or process-triggered workflow recursion.
- No process run skip/reopen/cancel/rework, and no deletion of process runs/step runs — history is permanent and unedited in v1.
- The Graph view (Process Graph 6A/6B) now supports direct add (insert-on-edge), delete (with an explicit reconnect choice where unambiguous), and reorder (button-based, guarded) — but it is still not a freeform canvas. There is no drag-to-move node positioning, no drag-to-connect/rewire edges, no layout persistence, and no moving a node across branches or into/out of a parallel region (only via delete-and-recreate).
- The Process Run Graph (6C) is read-only visualization of the run's authoritative snapshot — List remains the default view. There is no editing a template from a run, no changing a route or approval outcome after the fact, no manual runtime-state manipulation, no freeform canvas positioning, and no per-branch lane correlation for join obligations (parallel-join progress is shown as an aggregate "N of M branches" count plus each branch's own node status, not a token-to-lane mapping).
- Automated Action Nodes support one action per node (create record, update origin record, update related record, start process) — no multi-action ordering, no HTTP/webhook/email/Slack/script/AI actions, no delays or custom retry policies, and no compensation/rollback. A retry recovers a genuinely transient failure (a value that changes) but can never recover a structurally misconfigured action, since the run's step config was already snapshotted at start time and template edits never affect an existing run. Idempotency for `create_record`/`start_process` closes the specific crash window between a successful side effect and its completion record; it is not a general exactly-once guarantee for arbitrary future action types. The Workflow editor's own action-configuration UI was not retrofitted onto the new shared component — it remains its own implementation.

## Development Principles

- Plan -> review -> implement -> test -> commit.
- Prefer small vertical slices over broad infrastructure.
- Favor structural database integrity where it meaningfully protects data.
- Keep workspace scoping explicit in repository calls.
- Keep server-side validation authoritative.
- Do not silently rewrite/delete/null dependent data.
- Preserve backwards compatibility where reasonable.
- Use immutable IDs/keys for stored references; allow user-facing names/slugs to evolve.
- Build generic foundations with specific, understandable UI language.
- Avoid premature libraries, frameworks, ORMs, and deployment infrastructure.
- Use Server Components and Server Actions where they fit; Client Components are for interactive form state.
- Use accessible selectors in tests.
- Run lint, typecheck, webpack build, and E2E tests sequentially before declaring milestones complete.

## Agent Working Agreement

- The repository and checked-in migrations are the source of truth.
- Read `PROJECT_CONTEXT.md` before starting substantial work.
- Inspect existing code before proposing new architecture.
- Plan first when a milestone involves product semantics or architectural choices.
- Keep milestones small and coherent.
- Do not silently change established behavior outside the requested milestone.
- Reuse existing domain/repository abstractions where practical.
- Favor structural database integrity where appropriate.
- Do not silently rewrite or delete dependent data.
- Preserve backwards compatibility where reasonable.
- During implementation, prefer targeted verification: lint, typecheck, and directly relevant E2E spec(s).
- At milestone completion, run the full gate sequentially:

```bash
npm run lint
npx tsc --noEmit
npm run build -- --webpack
npm run test:e2e
```

- Do not run typecheck and build concurrently because of the known `.next` generated-types race.
- Update `PROJECT_CONTEXT.md` only when a milestone is complete or when durable architecture/process decisions change.
- Do not begin the next milestone without approval.
- If another coding agent has worked on the repo since your last session, re-read `PROJECT_CONTEXT.md` and inspect the current diff/history before proceeding.

## Multi-Agent Development

This project may be worked on by Codex, Claude Code, or other coding agents.

- Only one agent should actively implement a milestone at a time.
- Agents should not assume their prior chat history is current.
- Each new session should orient from `PROJECT_CONTEXT.md` and the repository.
- Completed milestones should be tested, documented, and committed before another agent begins the next milestone where practical.
- A second agent may review another agent's work, but should not simultaneously rewrite the same feature unless explicitly requested.

## Current State And Next Frontier

Complete major capabilities:

- Configurable entity types and primitive/relation fields.
- Metadata-driven record creation, editing, table display, archiving/restoring, and safe deletion.
- Entity lifecycle management: rename, archive/restore, safe deletion.
- Field lifecycle management: add, edit safe properties, archive/restore, safe deletion.
- Relation fields with dedicated relational persistence and generic labels.
- Configurable entity display fields.
- Saved table views with filters, sorts, visible columns, and default view selection.
- Workspace home and shared navigation with active entity cards and capped saved-view shortcuts.
- First-run workspace onboarding with small editable Clients, Projects, Tasks, and Opportunities starter structures, atomically created through the authorized metadata setup wrapper; established Home and navigation emphasize operational record work while configuration is progressively disclosed.
- Operational UX Polish: shared page primitives, a table-first entity workspace, inline Add Record disclosure, explicit Manage views disclosure, secondary row/detail lifecycle actions, clearer record-form hierarchy, and refined Home/search/navigation presentation. It adds no domain or persistence capability.
- Workspace record search across active entities and records, with deterministic per-entity result caps and detail-page links.
- Record detail pages with outgoing links and derived reverse relationship visibility.
- Create related records from reverse relationship groups using the standard record-create form and validated origin-detail return navigation.
- Workflow management: create/edit/enable/disable/delete.
- Workflow triggers for record created and record updated.
- Workflow actions for create record, update triggering record, update one record reached through a direct triggering-record relation, and start one configured compatible Process Template against the original triggering record — composable as an ordered sequence of multiple actions per workflow (add/remove/reorder in the editor), executed sequentially with first-failure-stops semantics, no cross-action rollback, and structured per-action execution logging (`action_results`). Unknown/crafted action types are rejected by server form parsing rather than coerced to another action.
- Conditions, watched fields, constants, source-field mappings, text templates, relation mappings, deterministic execution, isolated failures, no recursion, and execution logs. Conditions/watched fields are workflow-level, evaluated once against the original triggering event regardless of how many actions the workflow has.
- Transition-aware record_updated conditions (`changed`, `changed_from`, `changed_to`, `changed_from_to`) evaluated against the previous/current values from the original user-edit event, with a save-time-and-execution-time-enforced invariant that a transition condition's field must also be watched.
- A consistent light UI theme: the app shell is pinned to its light palette regardless of OS/browser dark-mode preference, matching the hardcoded light-card design used throughout, so text never renders on a mismatched background.
- Entity hard deletion is blocked when a workflow's `create_record` action still targets that entity, alongside the existing record-count and relation-field checks — deletion is blocked, never cascaded, and the dependent workflow is left untouched.
- Faster Record Work: inline click-to-edit editing of text/number/date/boolean fields directly from the entity table, with explicit commit/cancel semantics, no autosave-on-blur, `router.refresh()`-based UI sync, a no-op short-circuit, and full reuse of the canonical record-update validation/repository/workflow path — inline edits fire `record_updated` workflows (including transition-aware conditions) exactly as the full edit form does. Relation and identity/display fields remain read-only inline; no migration or repository change was required.
- Process Templates + Process Runs (v1 foundation): reusable linear human-task templates (`ProcessTemplate`/`ProcessNode`/`ProcessEdge`, graph-capable persistence), started manually per compatible record or by a configured workflow action against its triggering record, into a `ProcessRun`/`ProcessStepRun` with full template/step snapshotting, sequential step completion with atomic activation cascade, at-most-one-active-run-per-template-per-record enforcement, and safe-delete integration blocking entity/record/template deletion while applicable/referenced. Five new select-only-for-authenticated tables, membership-checked SECURITY DEFINER write RPCs, no raw mutation path.
- Fixed Process-Step Assignment + My Work: each `human_task` node may be unassigned or fixed to one current workspace member, structurally guaranteed to belong to that workspace (composite FK to `workspace_memberships`) and structurally blocking membership removal while assigned — including on archived templates. Assignment/label are snapshotted onto `ProcessStepRun` at run start so later reassignment or membership loss never rewrites history. Completion is assignee-only when a step has an assignee, open to any workspace member otherwise, enforced inside `complete_process_step_run_authorized` via `auth.uid()`. A new primary-nav "My Work" page shows the authenticated user's own assigned active/pending steps (Ready now / Upcoming) from active runs only, deriving identity server-side, never from client input. Identity display is a single narrow RPC (`list_workspace_member_identities_authorized`) exposing only `{user_id, email}` — no profile subsystem, no Team Member entity linkage.
- Process Due Dates + Attention: optional bounded `hours`/`days` due rules live on ProcessNode config and snapshot into each StepRun; `due_at` is persisted only upon activation, with days defined as 24 elapsed hours. Overdue is derived from an active due StepRun, never a lifecycle state. My Work prioritizes Overdue, then other Ready now work, then Upcoming pending work. Due timestamps render as browser-local absolute dates, and no scheduler/reminder delivery exists yet.
- Process Graph 5A — Conditional Branching: template position is only editor/topological order; execution uses immutable per-run route snapshots. A source has one unconditional/default successor or ordered conditional routes plus exactly one default; first matching AND-condition wins, otherwise default. One successor activates, unreachable pending StepRuns become `skipped`, and reconvergent reachable steps remain pending. Branch checks use current live origin values; missing/archived condition fields fail completion atomically and may be retried after restoration. My Work stops its deterministic upcoming projection at unresolved splits and never shows mutually exclusive work early. Safe field deletion blocks both live template references and unresolved active-run route snapshots. `routing_result` retains selected route/target/outcome/time/concise condition context.
- Process Graph 5B — Parallel Paths + Joins: explicit split/join system nodes form validated, non-nested/non-overlapping parallel regions. A split activates all branch tokens; each branch may use ordinary conditional routing, an approval, or a wait; a join advances only after every expected token arrives, then its downstream work activates exactly once. Template node/route configuration and group/token topology are snapshotted per run, branch assignments/due dates remain local, and My Work may show multiple active assigned human tasks or approvals while suppressing waits/join/system work. Direct system-step completion is forbidden, join obligations are select-only runtime state, and malformed graph edits reject atomically. Parallel regions do not add loops, general parallel joins, automated nodes, or a visual graph builder.
- Process Graph 5C.1 — Approval Nodes: an approval is one explicitly assigned or unassigned human decision with two or more named, stable UUID-backed outcomes. Outcome IDs survive rename, reorder, and target changes; labels are trim/case-fold unique; multiple outcomes may share a target. Run start snapshots every outcome ID/label/target, so live template edits never alter active-run choices. `decide_process_approval_authorized` records the selected outcome and actor/time separately on the completed StepRun, then appends an `approval_outcome` routing result and advances exactly one snapshotted route. It uses the same assignment, due-date, My Work, advisory-lock, conditional, and parallel branch-token/join-obligation semantics as human tasks, but generic completion never accepts it. No comments, voting, delegation, escalation, timers, automation nodes, or reminders are included.
- Process Graph 5C.2 — Wait States: a wait is a timer-only system node with a structured, self-contained rule and a deterministic UTC `resume_at` calculated once at activation. It supports elapsed hours, timezone-aware calendar days/weekdays, and bounded calendar targets; it is scheduler-resumed through a narrow service-only RPC, has no assignee/due rule/manual completion/My Work entry, and preserves run snapshot, conditional-route, branch-token, and join semantics. External scheduler provider selection, holidays/business calendars, manual skip/cancel/resume, reminders/notifications, recurrence, automated nodes, and visual builder work remain deferred.
- Process Graph 5C.3 — Condition/Event Waits: a condition wait snapshots one direct origin/related target and typed AND conditions, then resumes only through the service-only durable wakeup dispatcher when current authoritative values satisfy them. Dependencies and wakeups are distinct, related targets can rebind, and direct or workflow-originated writes use the same trigger/outbox path. No polling condition, arbitrary/reverse/multi-hop traversal, condition-history UI, manual resume/skip/cancel, notifications, automated nodes, or visual builder work was added.
- Process Graph 6A — Visual Process Builder Foundation: the template editor gained a List/Graph toggle over one shared client-side step/route state, with no new persistence or migration. Graph view renders every node type distinctly (human task, approval, wait, condition wait, parallel split/join) and every route as a labeled edge, including conditional routing and approval outcomes as edge/route behavior rather than a separate node type. Selecting a node opens a side panel built from the same shared per-node editing components the List view uses, so the two views can never present different controls. Layout is computed fresh on every render from existing node position/edge data — never stored — using plain rank ordering plus a bounded lane walk for parallel regions; no graph layout library was needed. Reordering remains List-only. Fixed alongside verification: a pre-existing bug where reopening a template with a `condition_wait` step for editing lost its saved condition configuration.
- Process Graph 6B — Direct Graph Editing: the Graph view became a practical primary editor without a second graph semantics layer — insert-on-edge (add), an explicit delete choice (reconnect vs. not) for unambiguous nodes, and a guarded button-based reorder (List and Graph both refuse an adjacent swap that would break an existing route's forward validity, with a visible reason) are all sugar over the same `steps`/`routes` array model 6A established. Non-adjacent edges now route through a deterministic side gutter instead of drawing through occupied node cards, fixing the known occlusion issue. Fixed alongside verification: the wait-amount validator's regex was double-escaped inside a regex literal and rejected every wait amount unconditionally. Found and flagged, then fixed in a follow-up pass (Wait UI Bug Fixes, below): a client-side crash on any interaction with the Wait Amount input, and a separate bug where hours-duration waits always failed to save due to an always-resnapshotted timezone the RPC rejects.
- Wait UI Bug Fixes: fixed the Wait Amount input crash (every `WaitConfigFields` handler read the SyntheticEvent's `currentTarget` inside a Strict-Mode-doubled, asynchronously-invoked state updater — fixed by capturing each value synchronously in `onChange` instead) and the hours-duration timezone leak (`getWaitRule` now gates timezone inclusion on `unit === "calendar_days"` rather than truthiness). Both verified by reverting each independently and confirming the regression test genuinely fails, then passes restored.
- Process Graph 6C — Visual Process Run / Execution View: Process Run detail gained the same List/Graph toggle (List remains default) over one runtime-snapshot-driven graph — no second runtime semantics model and no new persistence. `computeProcessGraphLayout` was type-narrowed to a minimal structural interface so the same layout algorithm and gutter-routing serve both template editing and run visualization; a dedicated adapter maps a run's already-immutable snapshotted steps/routes into that shape. Nodes render completed/active/pending/skipped status as both color and explicit text; routes render a three-way taken/untaken/undetermined state driven by each step's own `routingResult`, using color/opacity/width rather than dashing alone so it can't be confused with the template graph's dash semantics. Approval and conditional decision history, parallel branch/join progress ("N of M branches joined"), and wait/resume context all reuse the same prose the List view already had, via a shared summaries module. The existing `CompleteStepButton`/`ApprovalDecisionButtons` — no new action components or server actions — surface in the Graph side panel per selected step-run, gated by the same active/human-actionable/authorized rule List already enforced.
- Automated Action Nodes: a process step (`action` node) performs create record, update origin record, update related record, or start process automatically on activation, reusing the exact `WorkflowAction` shape and `executeSingleAction` executor workflows already use. One canonical system action-step executor runs identically whether the step was activated by human completion, an approval, a timer wait, a condition wait, another action, or parallel/system advancement — the wait/condition-wait scheduler drains any action node it activates through that same executor under its own admin client, never a separate or broader execution path. Failure represents entirely through `action_result.status = 'failed'` on an otherwise-still-`active` step (no new runtime status), visible in List and Graph with a Retry control open to any workspace member. `create_record`/`start_process` are idempotent against a retry after a crashed-but-successful attempt via a durable `originating_process_step_run_id` identity, closing the specific duplicate-creation window that risk implied. My Work, template/entity/field safe-delete, and process-template deletion all treat action nodes consistently with every other config-bearing node type.
- Automated Playwright E2E harness covering representative entity, relation, archived-relation edit preservation, display-field, saved-view, record-detail, related-record creation, workspace navigation/search, workflow, record-updated, record-updated transition conditions, update-record, update-related-record, multiple-ordered-actions, dark-mode-contrast, inline record-editing, process template/run behavior, and process-step assignment/My Work behavior.
- Supabase Auth email/password sign-in, protected workspace access, explicit memberships, active-workspace selection, RLS tenant isolation, immutable workspace ownership, and authorized record mutation wrappers.
- Phase 7A — Roles and Permissions Foundation: one role per membership, custom roles, membership-wide workspace reads, capability-gated interactive mutation/configuration, atomic last-administrator-safe role transitions, and a narrow Members and Roles management UI.
- Phase 7B — Teams & Organizational Structure: flat workspace teams, multiple memberships/leads, and optional primary-manager reporting relationships, all kept separate from roles/capabilities and workspace-wide record visibility. Workspace Settings exposes functional Teams and Reporting controls to organization managers; no nested teams, team visibility rules, ownership, manager portfolio experience, or profile/invitation system is included.

Sensible next areas, without committing to architecture yet:

- Process reminders/notifications.
- Dynamic assignment (from an origin-record field, roles, expressions, round-robin, groups), workload counts/dashboards, and general reassignment of an in-flight step — all deliberately deferred from Fixed Process-Step Assignment + My Work.
- A Team Member entity concept that can optionally link to an authenticated workspace member, if/when richer people data is needed beyond email.
- Process loops, generalized gateways, automated/subprocess node types, and richer branch expressions.
- Freeform graph manipulation beyond 6B: drag-to-move node positioning, drag-to-connect/rewire edges, layout persistence, and moving a node across branches or into/out of a parallel region without delete-and-recreate.
- Process-*run* (instance) graph visualization, distinct from the template graph view Process Graph 6A/6B added.
- Future hardening of the remaining SECURITY-INVOKER entity/field create/update RPCs so their raw same-workspace mutation grants can be removed.
- Multi-role memberships, ownership, team-based record visibility, manager portfolio views, and row-scoped visibility are deliberately deferred to later Phase 7 work.
- Better workflow observability/history and possibly durable background execution.
- Richer record detail capabilities such as layouts, comments, attachments, and activity.
- Field/entity editing beyond currently safe properties.
- Richer saved views such as additional operators or alternate presentation modes.
- More workflow actions or conditions; an "unset" sentinel for transition-condition operands.
- Local/separate Supabase test environment before CI.
- Eventually, AI-assisted configuration of deterministic entity/field/workflow definitions.
