// Focused, dependency-free unit coverage for the new lib/domain/work-
// repository.ts pure mapping layer only. The async wrapper functions
// (getEntityTypeWorkSettingsConfig, setEntityTypeWorkMapping,
// setEntityTypeWorkEnabled, listAssignedRecordWork) call
// createServerSupabaseClient(), which depends on next/headers' cookies()
// and only resolves inside a real Next.js request -- they are exercised
// through the UI/E2E layer, not directly here. RPC behavior (validation,
// lifecycle protection, notifications, visibility, timezone) is already
// fully covered by work-settings-commit.test.ts and is deliberately not
// re-asserted in this file.
import { describe, expect, it } from "vitest";
import { mapAssignedRecordWorkRow, mapEntityTypeWorkSettingsRow } from "./work-repository";

describe("mapEntityTypeWorkSettingsRow", () => {
  it("maps every snake_case RPC column to its camelCase config field", () => {
    expect(
      mapEntityTypeWorkSettingsRow({
        work_enabled: true,
        work_assignment_field_id: "field-assignee",
        work_due_field_id: "field-due",
        work_status_field_id: "field-status",
        completion_option_ids: ["option-a", "option-b"],
      }),
    ).toEqual({
      workEnabled: true,
      assignmentFieldId: "field-assignee",
      dueFieldId: "field-due",
      statusFieldId: "field-status",
      completionOptionIds: ["option-a", "option-b"],
    });
  });

  it("maps null optional fields through as null, not undefined or a placeholder", () => {
    expect(
      mapEntityTypeWorkSettingsRow({
        work_enabled: false,
        work_assignment_field_id: null,
        work_due_field_id: null,
        work_status_field_id: null,
        completion_option_ids: null,
      }),
    ).toEqual({
      workEnabled: false,
      assignmentFieldId: null,
      dueFieldId: null,
      statusFieldId: null,
      completionOptionIds: [],
    });
  });
});

describe("mapAssignedRecordWorkRow", () => {
  it("carries the resolved label through and constructs the record-detail href from the row's own ids", () => {
    expect(
      mapAssignedRecordWorkRow(
        {
          entity_type_id: "et-1",
          entity_type_name: "Task",
          record_id: "rec-1",
          due_date: "2026-09-25",
          is_overdue: false,
        },
        "Renew the annual filing",
      ),
    ).toEqual({
      entityTypeId: "et-1",
      entityTypeName: "Task",
      recordId: "rec-1",
      recordLabel: "Renew the annual filing",
      dueDate: "2026-09-25",
      isOverdue: false,
      href: "/entities/et-1/records/rec-1",
    });
  });

  it("passes through a null due date and an overdue row unchanged", () => {
    const item = mapAssignedRecordWorkRow(
      { entity_type_id: "et-2", entity_type_name: "Household Task", record_id: "rec-2", due_date: null, is_overdue: false },
      "Record",
    );
    expect(item.dueDate).toBeNull();
    expect(item.isOverdue).toBe(false);

    const overdueItem = mapAssignedRecordWorkRow(
      { entity_type_id: "et-2", entity_type_name: "Household Task", record_id: "rec-3", due_date: "2026-01-01", is_overdue: true },
      "Record",
    );
    expect(overdueItem.isOverdue).toBe(true);
  });

  it("preserves whatever fallback label the caller resolved (e.g. the 'Record' label-resolution-failure fallback)", () => {
    const item = mapAssignedRecordWorkRow(
      { entity_type_id: "et-3", entity_type_name: "Client", record_id: "rec-4", due_date: null, is_overdue: false },
      "Record",
    );
    expect(item.recordLabel).toBe("Record");
  });
});
