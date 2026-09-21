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
Move the primary `+ Add Field` action to the bottom of the current field list, following the same append-at-the-end interaction model now used successfully for Choice `+ Add option`. The builder is most likely to decide they need another field while working at the end of the existing list, so the action should be available at that list terminus rather than requiring a scroll back to the section header.

Prefer one clear bottom-of-list append action over duplicate top-and-bottom controls, a sticky toolbar, or a floating button unless later testing shows those are necessary. Keep the treatment consistent with `+ Add option` where practical.

Continued hosted dogfood on 2026-09-19 confirmed this remains visible after the Create Object Choice improvements: the top-positioned Add Field control still requires the builder to move away from the current field list to append another field.

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

Hosted verification after commit `139e7d6`:
Saved options collapsing to compact rows is a clear improvement and should be preserved.

Residual friction remains in the new-option editor:
- the color chooser is still very tall because every color renders as a chip plus text label;
- consider a compact spectral swatch-only chooser with accessible labels/tooltips, or a single compact color dropdown on the same row as Label;
- the persistent success text ("Option added.") remains visible beside "New option (unsaved)" and "Save option", creating contradictory-looking state after the save. Treat success confirmation as transient feedback or otherwise clear/reset it after the action;
- when several saved options need maintenance, repeatedly opening each row may become tedious. Explore small, accessible quick-action affordances on the collapsed row (for example Edit and Archive). Avoid destructive trash semantics if the actual lifecycle is Archive rather than delete, and avoid putting interactive controls directly inside a native <summary> if cross-browser semantics are unreliable.

Hosted verification after commit `ab6629c`:
The swatch-only picker is materially more compact, transient success feedback works, and the Edit/Archive quick actions on collapsed live options are convenient without feeling cluttered.

Residual polish:
- the Label input in the new-option editor visually blends into the khaki/gray unsaved-state container and can look disabled; a normal white input surface would read more clearly as editable;
- archived options remain interleaved in their original position among active options. For management UX, consider separating archived options from the active list or moving them to a clearly labeled archived subsection/bottom area while preserving their underlying stable identity and historical position semantics;
- icon-first quick actions may be cleaner for dense option rows, but any icon treatment should retain accessible names/tooltips and should not imply hard deletion where the actual lifecycle is Archive.

Status:
Partially improved

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

Hosted verification after commit `ab6629c`:
The unsaved state and save action are now clear enough for continued use: the editor is visually distinct, uses "Save option", and transient success feedback no longer creates a contradictory-looking saved/draft state.

Status:
Fixed

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

Hosted verification after migration `0140_create_object_choice_fields.sql` and the subsequent Create Object Choice UI polish:
Choice is now available during initial object creation through the same authoritative transactional creation path as the other supported field types. Draft options can be configured in place, and the final custom color picker shows swatches in both the closed control and open list. Hosted Household dogfood confirmed the initial-create flow works as intended.

Status:
Resolved

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

Hosted verification after commit `139e7d6`:
The compact header is materially better overall, but some near-mobile widths still break down:
- the search input can become too narrow to be practically tappable;
- a long workspace/environment name can wrap to a second line and increase header height.

The next pass should test breakpoint behavior continuously rather than only at a few canonical widths. At narrow widths, give controls minimum usable tap/input dimensions and truncate or collapse workspace text before allowing the header to wrap.

Hosted verification after commit `ab6629c`:
The intermediate-width behavior is better and the previous wrapping/tapability failures are substantially reduced.

Product clarification from continued dogfood:
The workspace/environment name is not considered headline navigation context. In comparable SaaS products, users generally operate in one current environment without needing its name persistently displayed. Kinema should therefore treat the workspace switcher primarily as an account/workspace-control affordance rather than as a permanent text label. An icon-first trigger is appropriate, with the current workspace name revealed inside the dropdown/menu and preserved accessibly.

Status:
Partially improved


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

Hosted verification after migrations `0143_workspace_member_fields.sql` and `0144_workspace_member_assignment_deactivation_lock.sql`:
Workspace Member is now available as a first-class configurable field type in Create/Manage Fields and works on ordinary records. Household dogfood confirmed an `Assigned To` field can select a real workspace member, persist the stable member identity, and render it in record/table views. The implementation preserves deactivated historical references, rejects new deactivated assignments, supports saved-view filtering/export/API behavior, and serializes assignment against member deactivation using deterministic workspace-membership row locking.

The core missing primitive is therefore resolved. Operational semantics such as My Work, notifications, and record ownership remain intentionally separate and are tracked as distinct product questions rather than being implied by every Workspace Member field.

Status:
Resolved


### [2026-09-20] Workspace Member fields display email instead of a human name

Context:
Jeremy dogfooded the newly deployed Workspace Member field in the hosted Household workspace by adding an `Assigned To` field to Household Task and assigning a real workspace member.

What I was trying to do:
Choose and recognize a person naturally while assigning a record.

What happened:
The picker and record/table display use the member's email address as the visible identity label. This is technically unambiguous, but it reads like account metadata rather than a person's identity.

Why it matters:
Workspace Member is a human-facing operational primitive. Builders and workers should generally see recognizable person names, with email available only as secondary disambiguation where useful. Using email as the primary label makes ordinary assignment feel more technical than the rest of the workflow.

Initial classification:
UX friction / missing identity presentation primitive

Possible direction:
Introduce a canonical user-level display/full name associated with the Kinema account identity rather than duplicating names per workspace membership. Prefer one flexible display/full-name field over mandatory first-name/last-name structure. Collect it during invitation acceptance, account setup, or another appropriate onboarding point; preserve email as fallback for existing users and as secondary picker text where needed.

Do not change Workspace Member's stable storage identity: references should continue to use `user_id`, with names resolved for presentation.

Hosted verification after migration `0145_user_display_name.sql` and deployment:
Personal Settings now supports a global user-level display name. Workspace Member pickers show `Name — email`, while ordinary record/table/detail presentation prefers the human name with email fallback. Existing assigned records update their current presentation without changing stored `user_id`; referenced inactive values use the same name-first rule with an explicit Deactivated suffix. Process Template live assignee selection and member-admin presentation share the canonical label behavior. Household dogfood confirmed the assignment picker shows `Jeremy Parkin — djplana@gmail.com` and the record table displays `Jeremy Parkin`.

Status:
Resolved


### [2026-09-20] Quick view controls block has ambiguous scope and an inconsistent three-sided border

Context:
Jeremy reviewed the hosted Household Task record page at a narrower desktop width while continuing dogfood of the record/table experience.

What I was trying to do:
Understand and use the lightweight view controls immediately above the Add Task disclosure and records table.

What happened:
The block containing `+ Add filter`, `+ Add sort`, and `Columns` is visually enclosed by a border on only three sides, with no top border. This treatment is inconsistent with most other Kinema panels, which generally use either a complete four-sided border or no enclosing border.

The block is also ambiguous in scope. Its placement between the larger Records/Manage views area and the Add Task/table content does not make it immediately clear whether these controls affect:
- the current saved view;
- the table below;
- all records;
- or some other page-level state.

Why it matters:
The visual treatment makes the block look unfinished or accidentally clipped, while the unclear relationship to the surrounding sections increases cognitive load. View/filter controls should read as belonging to a specific surface, especially on a page that already contains a saved-view selector, Manage views disclosure, Add Task disclosure, and the records table.

Initial classification:
UX friction / information architecture / visual consistency

Possible direction:
First clarify the information architecture before applying cosmetic polish.

Prefer one of:
- visually integrate these controls into the records table/header area if they are table-local;
- integrate them into the current-view management surface if they operate on the selected saved view;
- or use a clearly labeled, complete panel if they intentionally form a distinct control region.

For border treatment, use a complete four-sided border or no enclosing border. Avoid three-sided containers unless there is a deliberate adjoining-panel relationship that is visually obvious.

Do not solve this as an isolated CSS tweak if the underlying scope remains unclear.

Implemented in commit `0f9a53757305133a053db4bf0ea4bac86218e198`:
The quickbar now uses a complete four-sided border and explicitly labels its scope with a visible `View controls` heading plus either `All Records` or `View: <name>`. Filter/sort/column behavior, URL-state semantics, pending-edit handling, and saved-view persistence are unchanged. Focused browser verification confirmed the scope label tracks the selected view, filters still narrow results, and the block remains usable at 375px without overflow.

Status:
Resolved


### [2026-09-20] Record Actions column hides two small lifecycle actions behind an oversized disclosure

Context:
Jeremy reviewed a Household Task row after adding the new Workspace Member field.

What I was trying to do:
Scan and manage an ordinary record from the table.

What happened:
The Actions column renders a relatively wide `More actions` disclosure/expander, which then reveals only Archive and Delete. The disclosure itself occupies almost as much space as the actions it hides.

Why it matters:
This creates unnecessary horizontal and interaction overhead in a dense operational table. Archive and Delete are already familiar record-lifecycle actions and do not benefit much from an abstract extra layer when there are only two of them.

Initial classification:
Minor UX / table-density polish

Possible direction:
Replace the current disclosure with compact direct action controls, likely conventional Archive and Delete/trash icons with accessible labels/tooltips and the existing confirmation/safety behavior. Keep Archive visually safer/more prominent than Delete, and do not make destructive behavior easier to trigger accidentally.

Prefer a small consistent icon vocabulary rather than another one-off action-menu treatment.

Implemented in commit `d37373ab8accc7ce38ab5a570ed748cdea1ef857`:
The record-table disclosure layer was removed. Actions now expose compact direct Archive/Restore and Delete controls in the row, with Delete retaining its existing destructive confirmation/safety behavior. The controls retain accessible visible labels and title tooltips, and focused E2E confirmed archive, delete cancel/confirm, accessibility labels, and narrow-width visibility. Small local inline SVGs were used rather than introducing a broader icon-system refactor.

Status:
Resolved


### [2026-09-20] Assigning a record to a Workspace Member does not create My Work or notification behavior

Context:
Jeremy created a real Household Task record, set an `Assigned To` Workspace Member field to himself, and then checked Notifications and My Work.

What I was trying to do:
Use a configured Task record as personally assigned operational work.

What happened:
The record correctly stores and displays the Workspace Member reference, but no assignment notification was created and nothing appeared in My Work. My Work currently represents Process StepRuns assigned to the current user, while Workspace Member fields intentionally have no automatic operational semantics.

Why it matters:
The current implementation is behaving as designed, but the dogfood expectation is strong product evidence. Once a builder creates fields named things like `Assigned To`, `Due Date`, and `Status`, a normal user reasonably expects Kinema to understand that the record represents work. The distinction between "member reference" and "work assignment" is architecturally important but invisible in the resulting worker experience.

Initial classification:
Product-model gap / strategic operational semantics

Possible direction:
Do not make every Workspace Member field imply assignment, notification, permissions, or My Work membership. Objects may legitimately contain Workspace Member fields such as Account Manager, Reviewer, Sponsor, or Approver that are not equivalent to personal work assignment.

Investigate an explicit builder-configured work-semantics layer for an EntityType. A future design could let the builder designate, deliberately and independently:
- which Workspace Member field represents assignment;
- which Date field represents due date;
- which Status/Choice field and values represent active/completed work.

Deterministic software could then use those declared semantics to power My Work and assignment/due-date notifications without inferring meaning from field names or conflating ordinary member references with Process authority.

Keep Process StepRun assignment as its own existing operational model. PLAN ONLY before implementation.

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

Hosted verification after commit `139e7d6`:
The white-strip styling problem is materially improved. The remaining question is information architecture: "Show archived fields" and "Show archived records" are separated by the field-preview/table surface, even though they are conceptually related archive-visibility controls. Consider whether they belong together in one compact archive-controls area.

Hosted verification after commit `ab6629c`:
Grouping the two controls is more coherent. Their current position is still debatable: if the field-preview table remains on the Manage Object page, placing the archive-visibility controls immediately below that preview may better communicate that they affect what is shown there.

Status:
Partially improved


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

Hosted verification after commit `139e7d6`:
The page is substantially better: specialized sections now collapse appropriately and Add Field has been folded into Manage Fields. The overall vertical-density problem is improved enough to continue dogfood.

One residual issue emerged: the collapsed "Add field" control is easy to overlook inside the Manage Fields card. It belongs in the right place, but should have slightly stronger visual affordance than an ordinary row/disclosure so builders can quickly find the primary schema-expansion action.

Hosted verification after commit `ab6629c`:
The strengthened Add field treatment is easy to find without becoming oversized. The original Manage Object density/Add Field placement problem is now resolved enough to close this finding; remaining Choice and archive-control polish is tracked separately.

Status:
Fixed

### [2026-09-19] Ordinary Manage Fields rows remain too vertically sparse

Context:
Jeremy reviewed the live hosted Household Manage Fields surface after the previous builder-density cleanup.

What happened:
Ordinary non-Choice fields still render as several stacked management rows: Name heading plus a large input, Type heading plus separate text, Required and Save, Move Up / Move Down text buttons, then Archive Field on another row.

Why it matters:
A modest object schema still becomes longer than necessary. The page improved at the section level, but routine field maintenance still carries too much vertical weight per field.

Initial classification:
UX friction / builder density

Possible direction:
Compact each ordinary field's primary controls into one responsive row at desktop and medium widths: name input, compact immutable type metadata, Required checkbox, explicit Save, conventional arrow/icon move controls with accessible names, and a visually secondary Archive action. Let the row wrap cleanly at narrow widths. Preserve Choice option management beneath Choice fields rather than redesigning option rows in this slice.

Hosted verification after the compact Manage Fields row work:
Ordinary fields now use a substantially denser responsive row with name, neutral read-only type metadata, Required, Save, compact move controls, and a secondary Archive action. The later type-badge softening kept the metadata legible without making it look editable. Hosted Household review accepted the resulting density.

Status:
Resolved

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

Hosted verification after migrations `0141_safe_pristine_field_type_change.sql` and corrective `0142_fix_choice_option_add_lock_ordering.sql`:
Kinema now allows an in-place type correction only while the field is genuinely pristine. The backend re-checks record values, relation rows, Choice options, display-field/Quality Review/people-sensitive designations, saved views, Automations/workflows, and Process references under the shared lock protocol before changing type. Field ID/key are preserved; non-pristine fields are blocked with specific reasons rather than silently converted or replaced.

A real concurrent-pair test exposed and then verified the `0142` lock-order correction for Choice-option creation. The corrected implementation passed 25/25 backend tests, 3/3 focused E2E, 16/16 focused Choice/Process/Workflow regressions, repeated concurrency runs, and hosted Household acceptance. A real pristine Text field was successfully corrected to Choice; a dependent field was correctly blocked with a truthful explanation.

Status:
Resolved


### [2026-09-19] Desktop navigation includes a redundant Home item

Context:
Jeremy reviewed the live hosted header after the responsive-header cleanup.

What happened:
The desktop navigation still includes a text "Home" item even though the Kinema logo already serves as the conventional Home affordance.

Why it matters:
Persistent navigation space is scarce, especially as the header approaches tablet/mobile widths. Keeping both the logo-home affordance and a separate Home label adds clutter without adding meaningful discoverability.

Initial classification:
Minor UX / navigation polish

Possible direction:
Remove the explicit Home navigation item and keep the Kinema logo linked to Home. Preserve an accessible label on the logo link so its destination is unambiguous to assistive technology.

Hosted verification after commit `ab6629c`:
The explicit Home item is gone, the Kinema logo still returns Home, and the result feels cleaner.

Status:
Fixed

### [2026-09-19] Search button is redundant

Context:
Jeremy reviewed the live hosted header after the responsive-header cleanup.

What happened:
The desktop header still renders a dedicated Search button next to the search field, even though Enter/Return already submits the search form.

Why it matters:
The button consumes valuable horizontal space and contributes to responsive pressure without providing unique functionality.

Initial classification:
Minor UX / responsive polish

Possible direction:
Remove the visible Search button at all widths and rely on native Enter/Return submission. Keep the input clearly identifiable as Search and preserve keyboard/focus behavior.

Hosted verification after commit `ab6629c`:
The visible Search button is gone and Enter/Return submission works as intended.

Separate observation: the current Household workspace has no records yet, so searches returning no results are expected under the existing search model, which searches active text fields on active records rather than object/schema names.

Status:
Fixed

### [2026-09-19] Entity archive/delete actions are visually heavy for secondary lifecycle controls

Context:
Jeremy reviewed Entity Settings in the hosted Manage Object screen after the first builder-UX cleanup.

What happened:
"Archive Entity" and "Delete Entity" remain full rectangular buttons directly beneath the core entity settings form.

Why it matters:
These are infrequent lifecycle/destructive actions rather than primary configuration actions. Their current button treatment gives them more visual weight than their expected frequency warrants and contributes to the page feeling administratively heavy.

Initial classification:
Minor UX / action hierarchy

Possible direction:
Explore a lower-emphasis treatment such as icon + text or compact text actions, while preserving a clear destructive distinction for Delete and an adequate confirmation/safety flow. Do not make destructive actions visually ambiguous or easy to trigger accidentally.

Hosted verification after commit `ab6629c`:
The lower-emphasis icon + text treatment is clearer and appropriately de-emphasized while Delete remains visibly destructive.

Status:
Fixed


### [2026-09-19] Iconography could reduce repeated action-label clutter in dense builder surfaces

Context:
During hosted verification of the second builder-polish slice, compact icon + text treatment improved Entity lifecycle actions, and Choice option rows still showed repeated Edit/Archive labels on every row.

What happened:
Several dense builder surfaces repeat short action labels many times. The repeated text is understandable but adds visual noise as schemas grow.

Why it matters:
Kinema is beginning to accumulate enough builder controls that a consistent icon vocabulary could improve scanability and responsive behavior. However, icon-only controls can reduce discoverability if introduced indiscriminately.

Initial classification:
Visual-system opportunity / UX polish

Possible direction:
Begin introducing a small, consistent icon vocabulary now for obvious repeated actions such as Edit, Archive, Restore, Move, Notifications, Menu, and workspace/account switching. Prefer icons where the meaning is conventional and repeated density is a real problem. Preserve accessible names/tooltips and use text where meaning is less obvious or consequences are significant.

Apply this deliberately rather than as a blanket icon-replacement sweep; each surface should still justify icon-only treatment.

Status:
Open

### [2026-09-19] Archived Choice options are interleaved with active options

Context:
Jeremy reviewed Choice option management after commit `ab6629c`.

What happened:
An archived option remains in its original list position between active options, rendered with Restore while surrounding options remain editable/live.

Why it matters:
Preserving historical option identity and position is correct at the data layer, but interleaving inactive options with live configuration makes the active option set harder to scan and maintain.

Initial classification:
UX friction / management presentation

Possible direction:
Two related needs should be investigated separately:

1. Presentation: archived options should not be interleaved with active options by default. Hide them behind a compact "Show archived choices/options" disclosure or place them in a separate archived subsection, while preserving restore behavior and stable identity.

2. Safe deletion: builders may reasonably want to permanently delete a mistaken Choice option before real work has begun. Investigate whether a hard-delete path can be allowed only when the option has no record references and no other dependent configuration. Do not assume record references are the only dependency; inspect saved views/filters, workflows, imports, API/config references, and any other persisted option-id consumers before defining the rule.

If an option has ever become meaningfully referenced, preserve archive/restore rather than silently rewriting dependent data.

Hosted verification after commits `3df76d4`, `5f90a7b`, `92ebb50`, and `693c183`:
Archived Choice options are now hidden behind a "Show archived options" disclosure, can be restored, and can be permanently deleted only when completely unreferenced. The safe-delete path blocks active/archived record values, saved-view Choice filters, and Quality Review draft/finalized configuration, and the related raw table-bypass paths are closed. Hosted Household verification passed for the archived disclosure, Restore, Permanent delete, and saved-view behavior after the corrective migrations.

Status:
Resolved

### [2026-09-19] New Choice option Label input reads visually disabled

Context:
Jeremy reviewed the compact new-option editor after commit `ab6629c`.

What happened:
The Label input inherits/blends with the khaki-gray unsaved-state container, making the editable field look somewhat grayed out or unavailable.

Why it matters:
The editor is now compact, but the primary input should look clearly interactive. Disabled-looking styling introduces hesitation in a high-frequency configuration action.

Initial classification:
Minor UX / visual polish

Possible direction:
Give the Label input a normal high-contrast editable surface (for example white) while retaining the distinct unsaved-state container around the new-option editor.

Hosted verification after commit `7e15af3`:
The Choice Label input now reads as editable in the compact new-option editor.

Status:
Fixed

### [2026-09-19] Primary gold buttons should keep dark text in light and dark themes

Context:
Jeremy compared the same primary Business Objects action in light and dark mode during Household dogfood.

What happened:
Gold/brass primary buttons are used in both themes. Dark text on the gold surface reads more clearly and provides better contrast than switching to light text in dark mode.

Why it matters:
Primary actions should preserve consistent, accessible contrast across themes. Theme inversion should not automatically invert button text when the brand surface itself remains a bright gold.

Initial classification:
Accessibility / visual-system consistency

Possible direction:
Keep dark text on Kinema's gold/brass primary-action buttons in both light and dark themes, provided contrast checks continue to pass for the canonical button background states. Treat the gold surface as a stable brand token with its own foreground token rather than deriving its text color from the surrounding page theme. Verify hover, focus, disabled, and any darker/lighter gold variants separately rather than assuming one foreground works for every state.

Status:
Open

### [2026-09-19] Field-type recovery UI has poor dark-mode contrast

Context:
Jeremy verified the new pristine-field type-change flow in the hosted Household workspace after migrations 0141/0142 and deployment.

What happened:
The recovery flow works functionally, but the dark-theme presentation is inconsistent and in places inaccessible-looking:
- the expanded "New type" panel uses a very light surface while its label and controls retain light-theme-derived foreground styling, producing light text on a light background;
- the immutable field-type chip is also rendered as a very light rectangle in dark mode, making it look visually disconnected from the surrounding dark surface and less polished than the equivalent light-theme treatment.

Why it matters:
This is a newly introduced builder recovery surface. Functional correctness is not enough if the control becomes hard to read or visually broken in one supported theme. The problem also suggests these elements are using fixed light surfaces or theme-inappropriate tokens rather than semantic surface/foreground pairs.

Initial classification:
Accessibility / dark-theme visual regression

Possible direction:
Fix this narrowly before closing the field-type-recovery slice:
- make the type-change panel use theme-aware surface, border, label, input, and button tokens so foreground/background contrast remains correct in dark mode;
- restyle the read-only field-type metadata chip to use a subdued dark-theme-compatible surface rather than a near-white fill;
- preserve the lighter neutral metadata treatment in light mode without making the chip look like an editable input;
- verify hover/focus/disabled states in both themes rather than only the resting state.

Avoid a broad theme-system refactor in this pass; treat this as local semantic-token cleanup for the newly added field-type-recovery UI and its adjacent type metadata.

Hosted verification after the scoped dark-mode polish:
The New type panel and immutable field-type chip now use dedicated theme-aware styling instead of fixed light-only surfaces. Light mode retains the previous neutral treatment; dark mode now has readable foreground/background contrast and a subdued metadata chip that remains visually distinct without looking editable. Focused E2E and static checks passed, and hosted light/dark acceptance confirmed the result.

Status:
Resolved

### [2026-09-20] Record Work setup looked configured before it was actually saved, and My Work exposed implementation taxonomy

Context:
Jeremy dogfooded the first hosted Record Work / Work Settings flow on the Household Task object after the backend and initial worker-facing UI shipped.

What I was trying to do:
Configure Task records as actionable work, assign a Task to myself, receive the assignment notification, and see it in My Work.

What happened:
The initial Work Settings UI split field mapping and activation into separate forms. It was easy to select an assignment field and leave with the impression that Work had been configured even though the mapping had never been submitted. The persisted Task assignment itself was correct, but `work_assignment_field_id` remained null, so the backend correctly produced neither a Record Work notification nor a My Work row. Governance audit history confirmed no mapping or enable event had ever been written.

The first My Work presentation also rendered separate Process work and Assigned records sections, each with their own Overdue/Upcoming-style buckets. In real use this felt repetitive and exposed Kinema's implementation distinction more strongly than the worker's actual question: what needs my attention now?

Why it matters:
A builder-facing configuration surface must make persisted vs. unsaved state unmistakable, especially when downstream behavior depends on an explicit opt-in. Separately, a person being referenced on a record does not necessarily mean the record is that person's work; durable ownership/oversight fields such as Account Manager or Executive Sponsor should not flood My Work.

Resolution:
Work Settings is now one coherent configuration card with persisted state badges (`Not configured`, `Configured, not active`, `Active`), explicit unsaved-change feedback, clear save/activate actions, and non-destructive disable behavior. Builder copy now says Work is for records that themselves represent something a person is expected to act on and explicitly warns against treating ordinary ownership relationships as personal work.

My Work now uses two worker-oriented sections: `Needs attention` combines active/ready Process work with eligible Record Work, while `Coming later` contains pending Process work only. Overdue is item-level treatment; records without due dates do not get a separate bucket. The underlying Process and Record Work domain models remain distinct.

Hosted verification:
The revised dogfood flow passed end to end: Task Work was configured and activated, assignment produced the expected notification and `Needs attention` item, completing the Task removed it from My Work, and disabling/re-enabling Work preserved the mapping as intended.

Status:
Resolved

