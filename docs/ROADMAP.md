# Kinema Roadmap

This roadmap describes likely product directions after the current Process Graph work. It is intentionally directional: the repository and `PROJECT_CONTEXT.md` remain the source of truth for what exists today, while each milestone should receive its own product and architecture design before implementation.

## Near-Term Next Milestone

### Automated Action Nodes

The next planned milestone is automated Process nodes: a Process step that performs a deterministic system action without waiting for a person.

The goal is to let a Process coordinate operational work and the underlying business records in one coherent flow. Candidate actions include:

- Create a record.
- Update a record.
- Update one direct related record.
- Start another process.

The key design principle is reuse. Process automation should invoke the same canonical deterministic action machinery already used by Workflows where that is sensible, rather than creating a second automation engine with subtly different validation, mapping, logging, or integrity rules.

The precise node lifecycle, failure behavior, configuration UI, and action scope remain implementation-design questions. This is a roadmap item, not yet an implementation specification.

## User Settings & Preferences

This is a horizontal product and platform foundation, rather than a numbered major phase.

**Goal:** Give each user a personal settings surface for preferences that should follow them across Kinema.

Likely areas include:

- Appearance and theme, including dark mode.
- Timezone.
- Date and time formatting.
- Notification preferences.
- Default landing page.
- Density and accessibility preferences where useful.

Personal preferences should remain clearly separate from workspace-wide configuration, administrator controls, and roles or permissions. The roadmap does not yet prescribe a persistence model or settings UI.

## Product Experience Principles

### Configure Deeply, Operate Simply

Kinema can remain highly configurable underneath without making ordinary workers feel as though they are using a database, schema editor, or process builder. Builders and administrators configure entities, fields, relationships, workflows, process templates, permissions, and workspace structure. Workers should primarily encounter purposeful operational surfaces: My Work, Team Work, process and run views, approvals, and records relevant to their job.

The product should provide powerful configuration underneath and opinionated, task-oriented UX on top. It should avoid the failure mode where everyone lands in the backend simply because the system is flexible.

### Win on Custom Operations, Not Commodity Task Lists

Kinema should not try to become a generic Asana or Monday clone. Its stronger fit is organizations whose work does not fit standard task and project tools: they need custom business objects, relationships between them, repeatable processes, automation, role- and team-aware operations, and tailored operational views.

The intended position is: more structured and purpose-built than a flexible database, and more adaptable than a conventional project-management tool. Product decisions should not overfit Kinema to generic task management at the expense of that operational depth.

### Make Operational Delivery Native

As Kinema becomes a daily tool for employees, assignments and process events should naturally reach the relevant person. Future notification and reminder work should be a first-class operational layer for events such as new assignments, approvals needed, overdue or upcoming work, newly ready steps, satisfied waits or conditions, and failed automated actions requiring attention.

The likely pattern is deterministic operational state leading to a notification rule, then an in-app notification and optionally email or another external channel. This should build on existing process and work state, not create a second workflow engine. Personal notification preferences belong in [User Settings & Preferences](#user-settings--preferences) when that foundation is designed.

### Attack Setup Cost, Eventually with AI Assistance

A configurable system fails if it requires an expert builder for every new workspace. Kinema should steadily reduce setup friction and, in the longer term, use AI to configure deterministic software rather than improvise routine operations.

For example, a description of a monthly client-report process could lead Kinema to propose entities, fields, relationships, teams, process templates, assignments, due rules, workflows, and operational views. A user reviews and edits the proposal before creating the deterministic configuration. The long-term differentiator is AI as the expert system builder an organization would otherwise need on staff.

Until that guided layer exists, exposing first-time users directly to concepts such as Entity Type, Field Definition, Workflow Action, or Process Node risks recreating the setup-cost problem Kinema is meant to solve.

## Phase 7: People, Permissions & Management

After automated action nodes, the next major phase should make Kinema useful for several real users with different responsibilities, scope, and visibility. These areas belong together because permissions, organizational structure, and management views must reinforce the same operating model.

### 7A - Roles & Permissions Foundation

**Goal:** Move beyond workspace-wide, all-or-nothing membership.

Direction:

- Model roles as configurable bundles of capabilities, not only fixed Admin, Manager, and User labels.
- Control who can view, edit, and configure entities, processes, and operational data.
- Support future visibility rules such as "my records," "my team's records," and scoped business areas.
- Preserve strong workspace isolation and server-side enforcement.

The final permission model should be designed from real product needs rather than prematurely fixed in the roadmap.

Stronger roles, permissions, and administrator capabilities are also foundational for future workspace governance and hygiene policies: only authorized administrators should configure or review those controls.

### 7B - Teams & Organizational Structure

**Goal:** Represent responsibility relationships within an organization.

Potential concepts:

- Teams and groups.
- Manager and report relationships.
- Team membership.
- Responsibility scopes.

This foundation should make it possible to understand work assigned to an individual, their team, people reporting to a manager, or an accountable business group.

### 7C - Manager / Portfolio Experience

**Goal:** Give managers a useful view across people and work, not simply a larger My Work queue.

Potential views and signals:

- Active work across a team.
- Overdue, blocked, and waiting processes.
- Portfolio on-track and at-risk status.
- Workload distribution.
- Approvals needing attention.
- Bottlenecks and aging work.

The emphasis should be operational attention and understanding, not dashboard clutter.

### 7D - Operational Analytics & Performance Trends

**Goal:** Use durable process history to reveal trends over time.

Potential measures:

- Cycle and turnaround time.
- On-time completion.
- Overdue rates.
- Throughput.
- Workload over time.
- Approval turnaround.
- Rework and revision frequency.
- Recurring bottlenecks.

Kinema should not collapse employee performance into a simplistic single productivity score. Measures should be transparent, evidence-based, and interpreted with context: role differences, work complexity, workload, external waits, and process type all matter.

## Workspace Governance & Hygiene Policies

This is a substantial later product area, likely following the People, Permissions & Management phase.

**Goal:** Let administrators define recurring rules that keep a workspace clean, complete, and operationally healthy.

Potential capabilities:

- Detect stale or incomplete records.
- Detect missing ownership.
- Identify stuck or unusually old processes.
- Detect orphaned relationships or inactive owners.
- Flag possible duplicate records.
- Archive records after configured conditions or time periods.
- Surface workspace-health issues for review.

Hygiene checks should surface issues for human review. Deterministic hygiene actions may run automatically only where their safety is clear. This area should reuse Kinema's typed conditions, scheduled/background execution, deterministic automated actions, archive and lifecycle safety, roles and permissions, and operational history as they mature.

Destructive cleanup automation must never be casual: it requires clear administrator control, auditability, and, where appropriate, a preview or review path before action.

## Administrator Impersonation / Ghost Mode

**Goal:** Let an authorized administrator temporarily operate Kinema as another user in the same workspace for development, troubleshooting, support, and permission validation. It should make it practical to verify exactly what a user can see and do, reproduce reported issues, test role/capability and team/manager scope, and exercise My Work, Team Work, Analytics, and future row-scoped visibility from realistic perspectives.

This is not a read-only "view as" feature. The intended internal/dogfooding version supports full-control operation: actions should behave as though the target user performed them. That makes it especially valuable before public SaaS launch, when builders need to switch rapidly among test users without departing from the real application.

The design must distinguish two identities:

- **Real actor:** the authenticated administrator who initiates the session.
- **Effective user:** the workspace user whose perspective, permissions, and scope are evaluated for ordinary Kinema actions.

The real actor must hold a dedicated capability such as `workspace.impersonate_users`, and impersonation must use strict same-workspace validation. It must never be implemented by logging in with another user's credentials or casually swapping tokens. Instead, it needs an explicit application-level identity context that retains both identities server-side. System and service identities must not be impersonable, and the effective user must never inherit the administrator's additional powers.

Eventual safeguards include a persistent visual banner naming both identities, one-click exit, audited session start and end, and audit records for mutations made under impersonation that retain both real actor and effective user. A production support mode may additionally require a reason, detailed audit history, optional read-only support access, and separately designed platform-level customer-support safeguards for a future multi-tenant SaaS model.

Likely staged delivery:

- **V1:** Internal/admin-only, full-control, same-workspace impersonation with a strong indicator, easy exit, effective-user authorization, and a basic audit trail.
- **Later:** Production support controls, reason capture, richer audit history, optional read-only support mode, and any platform-level support impersonation.

This work depends on and should reinforce roles and capabilities, teams/reporting, Team Work and Analytics, future row-scoped visibility, audit logging, and production support tooling. It remains future direction, not a current capability.

## Business Object Data Model Refinements

Worker/builder dogfooding of the Phase 8B record detail experience surfaced three real data-model gaps. Each is deliberately kept out of Phase 8B itself, since each needs a schema change and its own design pass rather than being folded into a presentation-layer milestone.

### Singular + Plural Object Labels

`EntityType` currently stores exactly one `name`, used everywhere regardless of grammatical context — correct for a record-page eyebrow ("Task"), wrong for a collection heading ("Task" instead of "Tasks") or an "All Task"-style navigation link. The preferred model is a second, nullable `pluralName`: seeded once at entity creation from a simple `+s`/`+es` default (a starting value only, never authoritative rendering logic), then builder-editable afterward like `name`/`description` already are. Consumers to migrate once this lands: the entity list page's title, the Home business-object card title, the contextual rail's "All {name}" link, and the All Objects index. Explicitly do not solve this with runtime pluralization heuristics — the one that already exists (`formatEntityGroupName` in `record-detail-view.tsx`, a crude `name.endsWith("s") ? name : name + "s"` used only for reverse-relation group headings) should eventually be replaced by real plural labels, not imitated elsewhere.

### Choice / Select Field Type

Fields like Status, Priority, Region, and Engagement Type are modeled as free-text today, which undermines filtering, automation conditions, and cross-record consistency. `FieldType` is a closed union threaded through the DB check constraint, field validation, the field-create UI, record validation, inline-edit eligibility, saved-view filter operators, and workflow condition value pickers — a new type is genuinely cross-cutting, not a small addition. Recommended v1: single-select only; builder-defined options stored with **stable IDs** (not raw strings), mirroring the existing precedent for process approval outcomes (outcome IDs survive rename; labels are edited without reinterpreting historical record values). The stored record value stays the option ID; display resolves ID→label the same way relation labels already resolve ID→label. Multi-select, option colors, and archivable options are explicitly deferred past v1 unless separately approved.

### Multi-Value / Many-to-Many Relations

Confirmed at the schema level (`entity_record_relation_values` has `unique (workspace_id, source_record_id, field_definition_id)`): every forward relation field is hard-constrained to at most one target per record. Reverse "collections" are purely derived by querying the other direction, not a different storage shape. Today's recommended pattern for a one-to-many need (e.g., several Analysts on one Account) is to put the relation field on the "many" side pointing at the "one" side — a join-style entity if necessary — and let the "one" side see it as a derived reverse group, exactly as `Deal → Account` and `Milestone → Engagement` already work. True many-to-many (an Analyst who also needs to see their own multiple Accounts as a first-class forward field, or per-pairing metadata) needs either array-valued relation storage or an explicit join-entity concept — real schema/architecture work, not committed to a design here.

## Query & List Performance

A Phase 8B dogfood performance review found `getRelationLookups` and `listIncomingRelationsForRecord` were each fetching an entire related entity type's table just to resolve a handful of labels; both were narrowed to fetch only the specific record IDs actually needed (see PROJECT_CONTEXT.md's Phase 8B closing pass). Two related, larger items were identified but deliberately not addressed as part of that fix:

- **Entity list page pagination.** The primary records table (and other full-table reads like it) has no `LIMIT`/pagination at the database level — already a documented Intentional Limitation, not new, but worth solving alongside any future list-scale work.
- **Real aggregate Home counts.** The Home page's per-object-type active-record counts currently fetch one column of every active record in the workspace and count client-side in JavaScript, rather than using a SQL aggregate (`count(*) group by entity_type_id` via an RPC, or parallel `count: "exact", head: true` calls). Runs on every Home page load; worth fixing as real usage volume grows.

## Other Later Areas

These are candidates for later planning, without committed sequencing or detailed milestone definitions:

- Notifications and reminders.
- Business calendars and holiday-aware working days.
- Richer My Work and operational queues.
- Improved process dashboards.
- Automated and external integrations.
- Further graph-builder interaction, including drag and drop only if real usage justifies it.
- External event and webhook waits.
- AI-assisted configuration of entities, processes, and roles.

## Product Sequencing Principle

Kinema should avoid endlessly adding Process-engine primitives for their own sake. After Automated Action Nodes, the priority is making the system useful for multiple people with different responsibilities, authority, and visibility.

Real-world dogfooding should determine the ordering within the Phase 7 family. The underlying business logic should remain deterministic even where the product offers configurable experiences. Roadmap entries are direction, not commitments to exact schemas, permissions, or UX.
