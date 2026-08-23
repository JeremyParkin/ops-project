# Codex Project Context

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
- Hard deletion is blocked if any incoming relation references the target record. If unreferenced, deletion removes the record; source-side relation rows cascade through existing constraints/RPC behavior.

Entities:

- `entity_types.archived_at` implements archive/restore.
- Archived entities are hidden from normal navigation/selectors by default.
- Direct entity URLs remain viewable, but archived entities are read-only except restore/safe delete actions.
- Entity rename updates user-facing name/slug while preserving entity ID.
- Hard deletion is allowed only when the entity has zero records, including archived records; no field in the workspace has `related_entity_type_id` equal to that entity ID (self-relations count and block deletion); and no workflow's `create_record` action still targets that entity. The workflow check has no FK backing it (the entity-target relationship lives inside `actions[]` JSONB, not a column) — it is an explicit application-level `EXISTS` scan inside `delete_entity_type_if_safe`, deliberately blocking rather than cascading, matching the field-deletion dependency pattern below.

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

Workspace search:

- `GET /search?q=...` performs a case-insensitive trimmed substring search across active text fields on active records in active entities.
- Results are grouped by entity, capped at 20 records per entity, and link to record detail pages.
- For each entity, display-field matches rank before other text-field matches; prefix matches rank before general substring matches; remaining ties use label then record ID.
- A match outside the display field can show concise matching-field context. Search is deliberately limited to records: no fuzzy matching, pagination, workflow/view/settings search, or database search index in v1.

Record details and reverse relationships:

- Stable detail route: `/entities/[entityTypeId]/records/[recordId]`.
- Detail pages show active fields in schema order, human-readable primitive formatting, outgoing relation links, lifecycle actions, and derived incoming relationships.
- Archived records remain directly viewable, show archived state, and can be restored or safely deleted.
- Incoming/reverse relationships are derived from existing relation rows and metadata. They are not stored separately.
- Reverse relationship groups exclude archived source records, archived relation fields, and archived source entities.
- Active incoming relation fields produce a reverse group even when it has no records, so users can create the first related record.
- A reverse group can open the source entity's normal create form with its specific relation field prefilled to the current active record. The prefilled relation remains editable; successful creation and Cancel return to the originating detail page through validated origin entity/record IDs, never an arbitrary return URL.

## Workflow System

Workflow domain types are in `lib/domain/workflow-types.ts`; validation is in `lib/domain/workflow-validation.ts`; execution is in `lib/domain/workflow-engine.ts`; persistence is in `lib/domain/workflow-repository.ts`.

Implemented trigger types:

- `record_created`
- `record_updated`

Implemented action types (per step; see "Multiple ordered actions" below):

- `create_record`
- `update_record`
- `update_related_record`

Workflows are stored in `workflows` with `trigger_type`, `trigger_entity_type_id`, an ordered JSONB `actions` array (at least one element, enforced by a `jsonb_array_length >= 1` CHECK constraint), and a narrowed JSONB `action_config` holding only workflow-level `triggerConfig`/`conditions`. Each element of `actions` is one step: `{ actionType, actionTargetEntityTypeId?, relatedFieldDefinitionId?, fieldMappings }`. `create_record` requires `actionTargetEntityTypeId`; `update_record` targets the triggering record; `update_related_record` targets the current record reached through that step's own `relatedFieldDefinitionId`. The legacy top-level `action_type`/`action_target_entity_type_id` columns no longer exist (see Database And Migrations).

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
- `action_results` holds one ordered entry per action that actually began execution (never an entry for an action skipped because an earlier one failed first), each with `index`, `actionType`, `status` (`succeeded`/`failed`), and — where applicable — `actionEntityTypeId`, `actionRecordId`, `createdRecordId`, `resultMessage`, `errorMessage`.
- Legacy singular fields (`createdRecordId`/`actionEntityTypeId`/`actionRecordId`) keep their original single-action meaning for a workflow with exactly one action. For a workflow with more than one action they are `null` on a fully successful run (no single action to point at without being misleading) and describe the *failed* action on a failed run (a genuinely resolved, non-arbitrary target) — `action_results` is authoritative in both cases, especially for multi-action runs.
- The top-level `errorMessage` for a multi-action failure is prefixed with which action failed, e.g. `"Action 2 (update_related_record) failed: ..."`; a single-action workflow's error message is unprefixed, exactly as before this milestone.
- `resultMessage` for a multi-action success summarizes each action's outcome (`"Action 1: ... Action 2: ..."`); a single-action workflow's result message is unprefixed, exactly as before (e.g. still exactly `"No changes required."` for a single-action no-op).
- The workflow execution log UI (`app/workflows/page.tsx`) renders the `action_results` breakdown beneath the existing summary line only when there is more than one entry, so single-action and legacy logs render exactly as they did before this milestone.
- Action entity/record log fields intentionally do not have FKs so audit/history semantics are not undermined by future hard deletes.
- Deleting a workflow currently cascades its execution logs. This is acceptable for the prototype; audit preservation may change later.

## Database And Migrations

Migrations live in `supabase/migrations/` and are currently applied manually through the Supabase SQL Editor. The latest migration is:

- `0025_authorized_safe_delete_wrappers.sql`

`0019_workflow_multiple_actions.sql` added the ordered `actions` JSONB column (backfilling every pre-existing single-action workflow into a one-element array before enforcing `NOT NULL`/non-empty-array constraints), narrowed `action_config` to `{ triggerConfig, conditions }`, dropped the legacy `action_type`/`action_target_entity_type_id` columns and their constraints/FK, added `action_results` JSONB to `workflow_execution_logs`, and rewrote `delete_field_definition_if_safe` to scan all of `actions[]`. `0020_entity_delete_blocks_create_record_targets.sql` followed up: dropping `action_target_entity_type_id` also removed the composite FK that used to structurally block deleting an entity still targeted by a `create_record` action, so `delete_entity_type_if_safe` was rewritten (drop + recreate, since its `TABLE` return shape gained a column) to explicitly block that case instead.

`0021_auth_workspace_rls.sql` introduced Supabase Auth memberships and RLS for every workspace-scoped table. `0022_workspace_ownership_and_mutation_grants.sql` makes `workspace_id` immutable on every persisted workspace-scoped domain row. `0023_record_mutation_rpc_wrappers.sql` adds membership-checking, fixed-search-path SECURITY DEFINER wrappers for canonical record create/update/delete, allowing raw record/relation writes to be revoked. `0024_entity_create_display_field_grant.sql` restores the narrowly required display-field update permission for the still-SECURITY-INVOKER entity-creation RPC. `0025_authorized_safe_delete_wrappers.sql` revokes PUBLIC execution from privileged wrappers and adds equivalent authorized wrappers for safe entity/field deletion, allowing raw authenticated DELETE to be revoked for both tables.

Authenticated mutation grants are intentionally split:

- Records and relation rows: canonical authorized wrappers for create/update/delete; records retain only direct archive/restore timestamp updates.
- Entity types and field definitions: raw create/update writes remain available inside a member's own workspace because their canonical create/update RPCs are still SECURITY INVOKER and need those table privileges. Safe deletion is now wrapper-only. This preserves RLS tenant isolation but leaves technical same-workspace users able to bypass some app-layer entity/field create/update validation; wrapping those RPCs is future hardening.
- Entity views and workflows: direct member insert/update/delete remains because their repositories have no canonical mutation RPC. Workflow execution logs allow direct insert only.
- `workspace_memberships` is select-only to authenticated users; membership administration is privileged/bootstrap-only.

Major tables:

- `workspaces`
- `entity_types`
- `field_definitions`
- `entity_records`
- `entity_record_relation_values`
- `entity_views`
- `workflows`
- `workflow_execution_logs`

Important RPCs/functions:

- `create_entity_type_with_fields` creates an entity and its initial fields atomically.
- `add_field_definition` adds a field, assigns next position with an advisory lock, and rejects required fields when records already exist.
- `create_entity_record_with_relations` atomically creates primitive JSONB values and relation rows.
- `update_entity_record_with_relations` atomically updates primitive values and covered relation fields; omitted relation fields are untouched, covered optional relations can be deliberately cleared.
- `update_field_definition` renames fields and changes required status with transactional required-field validation.
- `set_entity_display_field` sets or clears the configured display field, enforcing active same-entity text fields.
- `set_entity_default_view` sets or clears the default saved table view without a circular entity/view FK.
- `delete_entity_record_if_unreferenced` blocks hard deletion when incoming references exist.
- `delete_entity_type_if_safe` blocks hard deletion for entities with records, entities with another field's relation pointing to them, or entities still targeted by any workflow's `create_record` action (scans `actions[]` across all workflows in the workspace). Never modifies or deletes the dependent workflow — deletion is blocked, not cascaded.
- `delete_field_definition_if_safe` blocks hard deletion for primitive JSON values, relation rows, workflow JSON references (scanning workflow-level `triggerConfig`/`conditions` plus every action's `relatedFieldDefinitionId`/`fieldMappings` across `actions[]`), display-field configuration, or saved table-view configuration.

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
- `app/workflows/page.tsx`, `app/workflows/new/page.tsx`, and `app/workflows/[workflowId]/edit/page.tsx` handle workflow listing, creation, editing, toggling, deletion, and log display.
- `app/components/entity-navigation.tsx` is the shared workspace navigation for Home, entities, Workflows, Create Entity, archived-entity management, and the compact record-search entry point.
- `app/components/record-create-form.tsx`, `record-edit-form.tsx`, `record-detail-view.tsx`, and `entity-records-table.tsx` are generic metadata-driven record UI.
- `app/components/entity-views-panel.tsx` manages saved table views.
- `app/components/workflow-create-form.tsx` is the reusable workflow definition form for create/edit.
- `app/components/field-*` and `entity-*` components handle metadata management.
- `lib/domain/types.ts` and `workflow-types.ts` define domain shapes.
- `lib/domain/metadata-repository.ts`, `record-repository.ts`, `view-repository.ts`, and `workflow-repository.ts` encapsulate Supabase access.
- `lib/domain/view-types.ts`, `view-engine.ts`, and `view-validation.ts` own saved-view behavior.
- `lib/domain/record-validation.ts`, `entity-definition-validation.ts`, `field-definition-validation.ts`, `field-edit-validation.ts`, and `workflow-validation.ts` own authoritative validation/parsing.
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

Shared helpers live in `tests/e2e/helpers/`, especially `supabase-test-data.ts`. E2E data ownership is centralized there. Each run gets a unique `E2E <suffix>` prefix/marker applied to test-created entity names, workflow names, and test record names where naming exists. Cleanup deletes prefixed workflows/entities and dependent records/relations from the current development Supabase project.

This first E2E setup intentionally uses the development Supabase project with namespaced disposable data. Before CI or broader team use, prefer a separate Supabase test project or local Supabase.

`playwright.config.ts` runs one Chromium worker, starts a production-style server with:

```bash
npm run build -- --webpack && npm run start:e2e
```

The default test URL is `http://localhost:3100`, overridable with `E2E_BASE_URL`. Global setup creates an ordinary authenticated E2E browser session and stores it at the ignored stable path `tests/e2e/.auth/e2e-auth.json`, outside Playwright-managed output directories. The auth/RLS security spec deliberately uses empty storage state. Traces, screenshots, and videos are retained on failure. Tests should prefer accessible selectors and stable user-facing semantics. Avoid brittle CSS selectors and add `data-testid` only when accessible selection is genuinely insufficient.

Current full-suite baseline after Auth & Workspace Foundation: 96 tests passing. The Auth/RLS security suite (`auth-workspace-security.spec.ts`) has 3 tests covering sign-in/no-access, active-workspace cookie validation, two-user/two-workspace RLS, immutable workspace ownership, raw grant boundaries, authorized wrappers, and cleanup.

## Intentional Limitations

- Email/password Auth only; users are pre-provisioned and explicitly assigned workspace memberships. No signup, invitations, roles, or workspace administration UI.
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
- Workspace record search across active entities and records, with deterministic per-entity result caps and detail-page links.
- Record detail pages with outgoing links and derived reverse relationship visibility.
- Create related records from reverse relationship groups using the standard record-create form and validated origin-detail return navigation.
- Workflow management: create/edit/enable/disable/delete.
- Workflow triggers for record created and record updated.
- Workflow actions for create record, update triggering record, and update one record reached through a direct triggering-record relation — now composable as an ordered sequence of multiple actions per workflow (add/remove/reorder in the editor), executed sequentially with first-failure-stops semantics, no cross-action rollback, and structured per-action execution logging (`action_results`).
- Conditions, watched fields, constants, source-field mappings, text templates, relation mappings, deterministic execution, isolated failures, no recursion, and execution logs. Conditions/watched fields are workflow-level, evaluated once against the original triggering event regardless of how many actions the workflow has.
- Transition-aware record_updated conditions (`changed`, `changed_from`, `changed_to`, `changed_from_to`) evaluated against the previous/current values from the original user-edit event, with a save-time-and-execution-time-enforced invariant that a transition condition's field must also be watched.
- A consistent light UI theme: the app shell is pinned to its light palette regardless of OS/browser dark-mode preference, matching the hardcoded light-card design used throughout, so text never renders on a mismatched background.
- Entity hard deletion is blocked when a workflow's `create_record` action still targets that entity, alongside the existing record-count and relation-field checks — deletion is blocked, never cascaded, and the dependent workflow is left untouched.
- Automated Playwright E2E harness covering representative entity, relation, archived-relation edit preservation, display-field, saved-view, record-detail, related-record creation, workspace navigation/search, workflow, record-updated, record-updated transition conditions, update-record, update-related-record, multiple-ordered-actions, and dark-mode-contrast behavior.
- Supabase Auth email/password sign-in, protected workspace access, explicit memberships, active-workspace selection, RLS tenant isolation, immutable workspace ownership, and authorized record mutation wrappers.

Sensible next areas, without committing to architecture yet:

- Future hardening of the remaining SECURITY-INVOKER entity/field create/update RPCs so their raw same-workspace mutation grants can be removed.
- Better workflow observability/history and possibly durable background execution.
- Richer record detail capabilities such as layouts, comments, attachments, and activity.
- Field/entity editing beyond currently safe properties.
- Richer saved views such as additional operators or alternate presentation modes.
- More workflow actions or conditions; an "unset" sentinel for transition-condition operands.
- Local/separate Supabase test environment before CI.
- Eventually, AI-assisted configuration of deterministic entity/field/workflow definitions.
