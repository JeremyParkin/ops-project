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

Server-side Supabase access is centralized in `lib/supabase/server.ts`. It reads:

- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SECRET_KEY`

The secret key must remain server-only. This prototype has no auth/RLS yet, and server-side secret access bypasses RLS. Tenant/security hardening will require a different model later.

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

`Workspace` is the top-level tenant boundary. The app currently uses one hard-coded demo workspace ID in `lib/domain/demo-ids.ts`, but repository calls keep `workspaceId` explicit.

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
- Hard deletion is allowed only when the entity has zero records, including archived records, and no field in the workspace has `related_entity_type_id` equal to that entity ID. Self-relations count as structural references and block deletion.

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

Implemented action types:

- `create_record`
- `update_record`
- `update_related_record`

Workflows are stored in `workflows` with `trigger_type`, `trigger_entity_type_id`, `action_type`, nullable `action_target_entity_type_id`, and JSONB `action_config`. `create_record` requires an action target entity. `update_record` targets the triggering record, while `update_related_record` targets the current record reached through `action_config.relatedFieldDefinitionId`; both have no action target entity ID.

Conditions:

- Stored in `action_config.conditions`.
- Empty conditions means always run.
- Conditions are AND-only.
- Supported operators include equality/inequality, numeric comparisons, date before/after, and `is_set`/`is_not_set`.
- At execution time, all condition configuration is fully validated before evaluation. Broken config logs `failed`; non-matching valid conditions log `skipped` with “Workflow conditions did not match.”
- Conditions evaluate against the triggering record snapshot for that workflow event.

Record-updated watched fields:

- Stored in `action_config.triggerConfig.watchedFieldDefinitionIds`.
- A `record_updated` workflow must watch at least one field.
- ANY watched field changing qualifies.
- Invalid or archived watched fields log `failed`.
- If watched fields did not change, execution logs `skipped` with “Watched fields did not change.”

Field mappings:

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
- Eligibility/watch-field detection/conditions are based on the original persisted triggering event.
- `update_record` actions reload the latest authoritative triggering record before resolving mappings/templates and applying changes, so sequential update actions see earlier action effects.
- `update_record` modifies only explicitly configured fields, preserving unrelated active and archived primitive values and unrelated relation rows.
- A valid no-op `update_record` logs `succeeded` with result message “No changes required.” and does not perform an unnecessary DB update or bump `entity_records.updated_at`.
- `update_related_record` follows exactly one active direct relation field on the latest triggering record, then reloads and updates that one related record using the same mapping, compatibility, validation, atomic RPC, no-op, and no-recursion rules as `update_record`.
- `update_related_record` configurations require at least one mapping other than `leave_unchanged`. Missing relations, archived selected relation fields, archived target entities/records, and archived mapped fields fail execution. If a related target is resolved before a later failure, its entity/record IDs are retained in the execution log.

Execution logs:

- Stored in `workflow_execution_logs`.
- Status is `succeeded`, `failed`, or `skipped`.
- Logs include trigger entity/record, timestamps, error/result messages, legacy `created_record_id`, and newer `action_entity_type_id`/`action_record_id`.
- Action entity/record log fields intentionally do not have FKs so audit/history semantics are not undermined by future hard deletes.
- Deleting a workflow currently cascades its execution logs. This is acceptable for the prototype; audit preservation may change later.

## Database And Migrations

Migrations live in `supabase/migrations/` and are currently applied manually through the Supabase SQL Editor. The latest migration is:

- `0018_update_related_record_workflows.sql`

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
- `delete_entity_type_if_safe` blocks hard deletion for populated or structurally referenced entities.
- `delete_field_definition_if_safe` blocks hard deletion for primitive JSON values, relation rows, workflow JSON references including selected related-record fields, display-field configuration, or saved table-view configuration.

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

Shared helpers live in `tests/e2e/helpers/`, especially `supabase-test-data.ts`. E2E data ownership is centralized there. Each run gets a unique `E2E <suffix>` prefix/marker applied to test-created entity names, workflow names, and test record names where naming exists. Cleanup deletes prefixed workflows/entities and dependent records/relations from the current development Supabase project.

This first E2E setup intentionally uses the development Supabase project with namespaced disposable data. Before CI or broader team use, prefer a separate Supabase test project or local Supabase.

`playwright.config.ts` runs one Chromium worker, starts a production-style server with:

```bash
npm run build -- --webpack && npm run start:e2e
```

The default test URL is `http://localhost:3100`, overridable with `E2E_BASE_URL`. Traces, screenshots, and videos are retained on failure. Tests should prefer accessible selectors and stable user-facing semantics. Avoid brittle CSS selectors and add `data-testid` only when accessible selection is genuinely insufficient.

Current E2E count after the Workspace Record Search milestone: 75 tests passing.

## Intentional Limitations

- No authentication yet.
- No RLS yet; server-side Supabase secret key bypasses RLS in this prototype.
- One hard-coded demo workspace ID remains.
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
- No workflow recursion/chaining.
- No multiple actions per workflow.
- No schedules, queues, background workers, integrations, or webhooks.
- No AI configuration UI yet.
- No configurable delete/archive policies.
- Workflow execution is synchronous app-side execution.
- Workflow logs are basic execution records, not a durable audit ledger.

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
- Workflow actions for create record, update triggering record, and update one record reached through a direct triggering-record relation.
- Conditions, watched fields, constants, source-field mappings, text templates, relation mappings, deterministic execution, isolated failures, no recursion, and execution logs.
- Automated Playwright E2E harness covering representative entity, relation, archived-relation edit preservation, display-field, saved-view, record-detail, related-record creation, workspace navigation/search, workflow, record-updated, update-record, and update-related-record behavior.

Sensible next areas, without committing to architecture yet:

- Authentication and a real multi-workspace security model with RLS.
- Better workflow observability/history and possibly durable background execution.
- Richer record detail capabilities such as layouts, comments, attachments, and activity.
- Field/entity editing beyond currently safe properties.
- Richer saved views such as additional operators or alternate presentation modes.
- More workflow actions or conditions.
- Local/separate Supabase test environment before CI.
- Eventually, AI-assisted configuration of deterministic entity/field/workflow definitions.
