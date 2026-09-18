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
