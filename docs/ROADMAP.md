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
