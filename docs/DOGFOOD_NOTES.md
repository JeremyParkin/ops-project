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
