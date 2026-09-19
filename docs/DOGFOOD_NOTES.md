# Kinema Dogfood Notes

Purpose:
Capture observations from real use of Kinema before deciding whether they are bugs, UX friction, missing primitives, configuration issues, or future opportunities.

These are raw observations, not commitments.
Completed implementation belongs in PROJECT_CONTEXT.md.
Future committed work belongs in ROADMAP.md.

## Open observations

### [2026-09-18] Workspace timezone selector only offers UTC

Context:
Jeremy opened Workspace Settings in the hosted Household workspace.

What I was trying to do:
Set the workspace timezone for local recurring/scheduled work.

What happened:
The timezone control is a dropdown, but UTC is the only available option.

Why it matters:
The UI explicitly says this timezone drives local time-of-day scheduling such as recurring process runs. The Household workspace needs a real local timezone such as America/Toronto.

Initial classification:
Bug / UX friction

Possible direction:
Root cause investigated: the control was a prefilled `<input list>`/`<datalist>` combobox, not a real dropdown. Browsers filter datalist suggestions against the field's current text, and every workspace defaults to "UTC" -- so the moment the field opens, nothing else matches and no other option is ever shown. The backend already accepts any valid IANA timezone (including America/Toronto) with no changes needed. Fix: replace the control with a real `<select>` populated from the existing curated timezone list. Implemented in `app/components/workspace-timezone-settings.tsx`; pending live hosted verification before closing.

Status:
Fix planned

### [2026-09-18] Primary field naming is unclear during object creation

Context:
Jeremy began creating the first Household Task object in the live hosted workspace.

What I was trying to do:
Choose the first/display field for a Task object.

What happened:
The builder asks for "Field 1 Name" without explaining the special role of the first/display field. It was unclear whether the natural name should be "Task", "Task Name", or something else.

Why it matters:
The builder is being asked to understand structural/modeling conventions that may not be obvious from the UI.

Initial classification:
UX friction

Possible direction:
Consider clearer terminology or contextual helper copy such as "Primary field", "Display field", or "What should each Task be called?"

Status:
Open

### 2026-09-18 — Add Field action disappears during long object creation

Context:
Jeremy was creating the Household Asset object in the hosted Household workspace.

What I was trying to do:
Add several fields to a new object.

What happened:
The "Add Field" button is positioned only at the top of the Fields section. After adding only three fields, it was already off-screen while editing the newest field.

Adding further fields therefore requires scrolling back to the top to find "Add Field", then scrolling back down to continue configuring the new field.

Why it matters:
The friction grows directly with object complexity. Creating objects with 5, 10, 20, or 30 fields would require repeated unnecessary scrolling during a core builder workflow.

Initial classification:
UX friction

Possible direction:
Keep the add-field action available near the user's current working position. Options could include a sticky Fields toolbar, a persistent/floating Add Field action, or an additional Add Field action at the bottom of the field list.

Avoid introducing multiple competing controls unless testing shows that is clearer than a sticky action.

Status:
Open

### [2026-09-18] Choice-field configuration consumes excessive vertical space

Context:
Jeremy was configuring the Choice field for Household Asset Category in the live hosted workspace.

What I was trying to do:
Define and manage a small set of category options.

What happened:
Each saved option renders as a large expanded block. Color choices span multiple rows for every option, and option controls such as Save, Up, Down, and Archive wrap across multiple rows. Even a modest list of choices makes the Manage Fields page extremely tall.

Why it matters:
Choice configuration scales poorly as option count grows and makes ordinary schema editing feel visually heavy and slow. More sophisticated objects with several Choice fields would amplify the problem substantially.

Initial classification:
UX friction

Possible direction:
Explore a denser option-management layout, likely with saved options collapsed or summarized by default and editing controls revealed on demand. Preserve clear labels, colors, ordering, and archive behavior without rendering every control for every option at full size all the time.

Status:
Open

### [2026-09-18] New Choice option state and action are ambiguous

Context:
Jeremy was adding Choice options while configuring Household Asset Category.

What I was trying to do:
Enter and save a new option.

What happened:
The unsaved option editor looks very similar to already-created options, but its primary button says "Add Option" while existing options show "Save". It was unclear whether "Add Option" commits the option currently being edited or adds another blank option after it.

Why it matters:
The UI does not clearly distinguish draft/new state from persisted state, making a basic builder action feel uncertain.

Initial classification:
UX friction

Possible direction:
Make the unsaved state visually distinct and use action copy that clearly describes what will happen, such as "Save option" for committing the current draft and a separate, unambiguous control for creating another option if needed.

Status:
Open

### [2026-09-18] Choice field unavailable during initial object creation

Context:
Jeremy created the Household Asset object through the initial Create object flow.

What I was trying to do:
Define Category as a Choice field while creating the object.

What happened:
The Create object field-type selector offered Text, Number, Date, Boolean, and Relation, but not Choice. After the object was created, Choice was available through the Manage Fields surface.

Why it matters:
The same schema capability is available immediately after creation but not during creation, forcing an artificial two-stage workflow and making builders wonder whether Choice must be configured somewhere else.

Initial classification:
UX friction / feature-surface inconsistency

Possible direction:
Make supported field types consistent between initial object creation and later field management unless there is a genuine product or integrity reason for a difference.

Status:
Open

### [2026-09-18] Object configuration is too slow and repetitive for multi-field schemas

Context:
Jeremy was building the first real Household object through the hosted builder UI.

What I was trying to do:
Configure a modest Household Asset schema with several ordinary fields and one Choice field.

What happened:
Before even completing the first object, the workflow already required repeated add-configure-save interactions, substantial scrolling, and separate management steps for capabilities not available in the initial creation flow. Building each field one at a time felt disproportionately slow for a small schema.

Why it matters:
Kinema's value depends on builders being able to configure useful operational structures efficiently. If a basic object feels laborious, larger real-world schemas may become prohibitively tedious even when each individual control technically works.

Initial classification:
UX friction / opportunity

Possible direction:
Treat this as broader builder-workflow evidence rather than immediately adding bulk-edit infrastructure. First identify which friction comes from layout, inconsistent creation/manage capabilities, save mechanics, and excessive per-field controls; then simplify the highest-cost interactions before considering larger schema-authoring abstractions.

Status:
Open

### [2026-09-18] Relation setup forces target-object creation order and context switching

Context:
Jeremy was configuring the first Household object and considering fields that should reference another business object.

What I was trying to do:
Define a relation before the intended target object had been created.

What happened:
A Relation field requires an existing target object, so the relation cannot be completed until the target object is created elsewhere first. This forces the builder to plan object creation order or leave the current setup flow and return later.

Why it matters:
Real data models are often designed together rather than strictly one object at a time. Requiring all relation targets to pre-exist creates avoidable sequencing friction and interrupts schema-building flow.

Initial classification:
UX friction / opportunity

Possible direction:
Explore a lightweight "Create new object..." path from the relation-target control that can create a minimal target object and allow the current relation to be completed, with fuller configuration deferred. Avoid embedding a full nested object builder unless real use justifies that complexity.

Status:
Open


### [2026-09-19] Responsive header grows taller on smaller screens

Context:
Jeremy used the hosted Household workspace at a narrower desktop/browser width.

What I was trying to do:
Navigate the app normally while keeping the global header compact and usable.

What happened:
As the viewport narrows, the global header becomes significantly taller because the search field drops onto its own full-width row while Menu, Notifications, and the workspace/account control remain text-heavy. The responsive state therefore consumes more vertical space precisely when screen space is more constrained.

Why it matters:
The global header is persistent chrome. On smaller screens it should become more compact, not more dominant. The current layout reduces usable vertical space and makes ordinary navigation feel heavier.

Initial classification:
UX friction / responsive design issue

Possible direction:
Revisit the compact-header composition rather than simply stacking the desktop controls. Candidate directions include:
- use a conventional hamburger icon for the collapsed primary menu;
- use a bell icon for Notifications, with a small badge/dot only when unread notifications exist;
- reduce the search field width and allow Enter/Return to submit, removing the dedicated Search button if no accessibility or discoverability issue requires it;
- keep search on the same row where practical, or collapse it behind a search icon at narrower breakpoints;
- reassess whether the current workspace name needs to be permanently visible as a full-width text control, while preserving a clear and truthful account/workspace-switching affordance.

Do not assume icons alone are sufficient; any compact controls still need accessible labels/tooltips and understandable state.

Status:
Open


### [2026-09-19] Builders cannot define a user-assignment field while modeling ordinary objects

Context:
Jeremy was designing the first Household objects and wanted Household Task to carry an owner/assignee tied to an actual workspace user. This felt especially confusing because Kinema has previously supported visible user assignment in dogfood.

What I was trying to do:
Add a field to a configurable business object that references a real workspace member, so a Task record can be assigned to Jeremy, Natalie, or another user.

What happened:
The generic field model exposes business-object Relation fields, but there is no field type that directly references workspace members/users. A Relation can only point to an existing EntityType.

Current architecture confirms that user assignment already exists elsewhere: Process Template human-task/approval nodes may carry a fixed `assigneeUserId` tied structurally to a same-workspace membership, and resulting StepRuns feed My Work. That is Process work assignment, not a generic EntityRecord field. Kinema also supports an optional configurable Person EntityType linked explicitly to workspace-member identity, but ordinary business-object relations target Person records rather than workspace memberships directly.

Why it matters:
From a builder's perspective, Kinema visibly supports "assigned to a user" in one part of the product but offers no equivalent field while modeling an ordinary Task record. That makes it difficult to know whether the capability is missing or merely configured somewhere non-obvious. A plain Choice field with user names would be static, would not preserve identity, and would not naturally integrate with user-based operational features.

Initial classification:
Missing primitive / UX and conceptual consistency issue

Possible direction:
First investigate the intended product distinction between record ownership/assignment and Process step assignment, and make that distinction understandable in the builder experience. Evaluate whether Kinema needs a first-class workspace-member reference field (or similarly bounded identity-reference primitive) for metadata-defined business objects.

Do not assume the answer is to auto-create a default Users EntityType: the existing architecture intentionally separates authentication/workspace membership from configurable business data, and Person EntityTypes are optional business records linked explicitly to workspace identities. Any solution should preserve that boundary and stable identity.

If a member-reference field is introduced, separately decide whether and how it can drive My Work, notifications, dynamic Process assignment, filtering, or permissions. Do not silently make an ordinary record field confer process authority or row-level ownership semantics.

Additional product evidence:
Jeremy compared this to Salesforce-style record relationships: an Account can have an internal Account Owner who is a Salesforce user, while also relating to external Contact records and potentially additional internal team members in other roles. Kinema likely needs the same conceptual separation. Internal workspace-member references should be available as configurable fields alongside ordinary business-object Relations, with multiple independently named member fields possible on one EntityType (for example Owner, Account Manager, Reviewer, or Internal Team). External/business participants such as client contacts should remain ordinary relations to configurable business objects rather than being conflated with workspace identities.

Current product direction from dogfood:
Treat this as a strong candidate for a core field primitive rather than as a magical reserved ownership concept. The likely abstraction is a configurable `Workspace Member` reference field type that can be added to any metadata-defined EntityType, alongside Text, Number, Date, Boolean, Choice, and Relation. The builder chooses the field name and therefore its business meaning; Kinema should not reserve or special-case `Owner`.

Examples:
- Owner — Workspace Member
- Account Manager — Workspace Member
- Reviewer — Workspace Member
- Responsible Analyst — Workspace Member
- Internal Sponsor — Workspace Member

The field should reference stable same-workspace member identity, not copy names/emails as strings, and should support multiple independently named member-reference fields on the same EntityType. Evaluate single-member vs multi-member cardinality as part of the eventual design.

Keep later operational semantics explicit and separately configured. Merely adding a Workspace Member field must not automatically mean the record appears in My Work, changes record permissions, confers process authority, or triggers notifications. Those behaviors can be layered deliberately later if justified.

Status:
Open


### [2026-09-19] Guided workspace setup disappears after the first object is created

Context:
Jeremy began configuring the persistent Household workspace as a first-time builder. On the initially empty Home screen, Kinema offered a guided starter-structure flow with selectable default business objects. Jeremy chose to start from scratch instead. After creating the first custom object, the workspace was no longer considered new, and the guided starter flow was no longer available from Home.

What I was trying to do:
Continue setting up a coherent small workspace while learning Kinema's modeling concepts and discovering how existing capabilities such as Person identity, member assignment, relations, Choice fields, and processes fit together.

What happened:
The current onboarding model is effectively one-shot: the guided starter experience is shown only while the workspace has zero EntityTypes. Once the builder creates any object, Home becomes the established operational experience and the guided setup path disappears. At that point, further configuration requires the builder to already understand where features live and how Kinema's primitives fit together.

Why it matters:
Real first-time setup is iterative. A builder may reasonably create one object, discover missing needs, reconsider the model, or need help understanding existing concepts before the workspace is meaningfully configured. Treating "one object exists" as equivalent to "onboarding is complete" removes guidance too early.

The Household dogfood session produced repeated uncertainty around field types, Choice setup, Person designation, workspace-member identity, relations, field ordering, and configuration flow. This is strong evidence that builder assistance is not merely polish; reducing setup cognitive load is central to Kinema's configurable-product value proposition.

Initial classification:
UX friction / onboarding gap / strategic product evidence

Possible direction:
Preserve the established operational Home experience once data exists, but make guided setup re-enterable from an appropriate builder/configuration surface rather than tying it exclusively to the zero-EntityType state.

Guidance could evolve in layers:
- a reusable starter-object/template flow for adding common structures later;
- contextual setup guidance that explains relevant existing primitives while configuring an object;
- eventually AI-assisted configuration that proposes deterministic objects, fields, relations, member-reference fields, roles, processes, and other metadata from the builder's description, with explicit review/approval before creation.

Do not make AI a prerequisite for basic usability. Manual configuration should remain coherent and understandable, while AI can reduce setup effort for more complex systems.

Status:
Open


### [2026-09-19] Archived-field and archived-record toggles look visually unfinished

Context:
Jeremy was reviewing the Household Asset object in the hosted workspace.

What I was trying to do:
Use the ordinary object-management/table surface and understand the controls for revealing archived fields and records.

What happened:
The "Show archived fields" and "Show archived records" controls render as plain white horizontal blocks with essentially no internal padding or visible border treatment, leaving the text visually pressed against the edge. They look inconsistent with the otherwise structured panel/table styling around them.

Why it matters:
This is minor compared with the larger builder-flow issues, but these controls are part of the core schema/record-management surface. Their unfinished visual treatment makes the product feel less polished and can make them read more like stray text on a white strip than deliberate interactive controls.

Initial classification:
Minor UX / visual polish

Possible direction:
Choose one intentional interaction treatment rather than the current halfway state:
- if these are meant to behave like lightweight disclosure/text links, remove the large white background strip and style them clearly as links/disclosures;
- if they are meant to be full-width controls, give them deliberate padding, border/background treatment, spacing, and hover/focus states.

Prefer reusing one consistent disclosure/control style across Kinema where possible rather than solving these two rows with one-off CSS.

Status:
Open


### [2026-09-19] Manage Object page is too vertically dense and exposes too many expanded configuration sections

Context:
Jeremy was managing the Household Task object in the hosted workspace after initial creation.

What I was trying to do:
Review and refine the object's configuration, add fields, and manage existing fields.

What happened:
The Manage Object page presents Entity Settings, Sensitive people data, Quality Review lifecycle, Add Field, and the full Manage Fields list as separate, fully expanded vertical sections. Even a modest five-field object produces a very long page before any Choice options or additional advanced configuration are involved.

The standalone Add Field section also consumes permanent vertical space even when the builder is not actively adding a field, despite being conceptually part of field management.

Why it matters:
The page mixes basic object configuration, advanced optional features, field creation, and field management into one continuously expanded surface. This increases scanning cost and makes routine schema work feel heavier than it needs to be. The problem compounds on objects with many fields or Choice options.

Initial classification:
UX friction / information architecture

Possible direction:
Reduce default vertical density by making optional/advanced sections collapsible and collapsed by default where appropriate, while keeping core identity/configuration easy to find.

Consider folding Add Field into Manage Fields as an explicit "Add field" action that reveals the input UI only when invoked, instead of reserving a permanent standalone panel.

Be deliberate about what stays open by default:
- core Entity Settings may merit remaining visible;
- Sensitive people data and Quality Review are specialized capabilities and strong candidates for collapsed-by-default sections unless active;
- Manage Fields should remain prominent but use a denser layout and progressive disclosure for per-field actions.

Prefer a coherent reusable section/disclosure pattern rather than independent one-off collapsible implementations.

Status:
Open

### [2026-09-19] Field-type immutability has no builder recovery path

Context:
Jeremy created several Household Task fields as Text because Choice was unavailable during initial object creation. After discovering Choice was available only from the later Manage Fields surface, he attempted to correct those fields.

What I was trying to do:
Change existing fields such as Category, Status, or Priority from Text to Choice after realizing the initial field type was wrong.

What happened:
Field type cannot be changed after creation. The Manage Fields UI exposes name and required-state edits, but no type change.

This is not merely a missing UI control: current architecture intentionally treats field type as immutable. `update_field_definition` has never accepted a type parameter, and stored record values, relation rows, Choice option identity, filters, workflows, imports, and other references depend on stable field semantics.

Why it matters:
The integrity rationale is sound, but the builder experience provides no obvious recovery path after an understandable setup mistake. That is particularly painful when another UX limitation caused the mistake in the first place: Choice was unavailable during initial object creation, so Text was the only practical placeholder.

A first-time builder should not need to understand immutable schema internals to recover from choosing the wrong field type.

Initial classification:
UX friction / missing safe schema-evolution workflow

Possible direction:
Do not simply make field type mutable in place; that risks reinterpretation or corruption of existing data and dependent configuration.

Investigate an explicit safe replacement/conversion workflow instead. Depending on field state and compatibility, this could:
- explain why type cannot be directly edited;
- create a replacement field of the desired type;
- optionally preview and migrate compatible values where a deterministic mapping exists;
- surface dependent views, workflows, processes, imports, or other references that need review;
- preserve/archive the original field rather than silently rewriting history.

For a brand-new empty field with no records or dependencies, a narrower safe type-change path may be possible, but that should be proven from actual dependency rules rather than assumed.

This finding is also linked to the separate "Choice field unavailable during initial object creation" issue; fixing that creation inconsistency would prevent some of these recovery cases.

Status:
Open
