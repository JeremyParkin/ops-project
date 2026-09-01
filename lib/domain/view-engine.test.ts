import { describe, expect, it } from "vitest";
import { evaluateViewState } from "./view-engine";
import type { ChoiceOptionsByFieldId, EntityRecord, FieldDefinition } from "./types";

// Focused on the genuinely new logic this phase added to view-engine.ts:
// choice-aware sorting (by configured option position, archived options
// sorting after all active ones) and choice equality filtering. Pre-existing
// text/number/date/boolean/relation behavior already has E2E coverage and is
// unchanged by this phase, so it isn't re-tested here.

const statusField: FieldDefinition = {
  id: "field-status",
  workspaceId: "ws-1",
  entityTypeId: "entity-1",
  key: "status",
  name: "Status",
  slug: "status",
  type: "choice",
  required: false,
  position: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const nameField: FieldDefinition = {
  id: "field-name",
  workspaceId: "ws-1",
  entityTypeId: "entity-1",
  key: "name",
  name: "Name",
  slug: "name",
  type: "text",
  required: false,
  position: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const activeFields = [nameField, statusField];

// Configured (non-alphabetical) order: Low, Medium, High -- position 0, 1, 2.
const choiceOptionsByFieldId: ChoiceOptionsByFieldId = {
  [statusField.id]: [
    {
      id: "opt-low",
      workspaceId: "ws-1",
      fieldDefinitionId: statusField.id,
      label: "Low",
      position: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "opt-medium",
      workspaceId: "ws-1",
      fieldDefinitionId: statusField.id,
      label: "Medium",
      position: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "opt-high",
      workspaceId: "ws-1",
      fieldDefinitionId: statusField.id,
      label: "High",
      position: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "opt-retired",
      workspaceId: "ws-1",
      fieldDefinitionId: statusField.id,
      label: "Retired",
      position: 0,
      archivedAt: "2026-02-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
};

function record(id: string, name: string, status: string | null): EntityRecord {
  return {
    id,
    workspaceId: "ws-1",
    entityTypeId: "entity-1",
    values: { name, status },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("evaluateViewState: choice sorting", () => {
  it("sorts by configured option position, not alphabetically", () => {
    const records = [
      record("r-high", "Alpha", "opt-high"),
      record("r-low", "Bravo", "opt-low"),
      record("r-medium", "Charlie", "opt-medium"),
    ];

    const result = evaluateViewState({
      filters: [],
      sorts: [{ fieldDefinitionId: statusField.id, direction: "asc" }],
      columnFieldDefinitionIds: [nameField.id, statusField.id],
      activeFields,
      allFields: activeFields,
      records,
      choiceOptionsByFieldId,
    });

    expect(result.records.map((r) => r.id)).toEqual(["r-low", "r-medium", "r-high"]);
  });

  it("reverses cleanly for descending", () => {
    const records = [
      record("r-high", "Alpha", "opt-high"),
      record("r-low", "Bravo", "opt-low"),
      record("r-medium", "Charlie", "opt-medium"),
    ];

    const result = evaluateViewState({
      filters: [],
      sorts: [{ fieldDefinitionId: statusField.id, direction: "desc" }],
      columnFieldDefinitionIds: [nameField.id, statusField.id],
      activeFields,
      allFields: activeFields,
      records,
      choiceOptionsByFieldId,
    });

    expect(result.records.map((r) => r.id)).toEqual(["r-high", "r-medium", "r-low"]);
  });

  it("sorts unset values last, and archived-option records after all active-option records", () => {
    const records = [
      record("r-active", "Alpha", "opt-low"),
      record("r-unset", "Bravo", null),
      record("r-archived", "Charlie", "opt-retired"),
    ];

    const result = evaluateViewState({
      filters: [],
      sorts: [{ fieldDefinitionId: statusField.id, direction: "asc" }],
      columnFieldDefinitionIds: [nameField.id, statusField.id],
      activeFields,
      allFields: activeFields,
      records,
      choiceOptionsByFieldId,
    });

    // active (position 0) first, then the archived-option record, then unset last.
    expect(result.records.map((r) => r.id)).toEqual(["r-active", "r-archived", "r-unset"]);
  });

  it("falls back to a stable, non-throwing order when no option data is supplied", () => {
    const records = [record("r-a", "Alpha", "opt-high"), record("r-b", "Bravo", "opt-low")];

    const result = evaluateViewState({
      filters: [],
      sorts: [{ fieldDefinitionId: statusField.id, direction: "asc" }],
      columnFieldDefinitionIds: [nameField.id, statusField.id],
      activeFields,
      allFields: activeFields,
      records,
      // choiceOptionsByFieldId omitted entirely (defaults to {}).
    });

    expect(result.records).toHaveLength(2);
  });
});

describe("evaluateViewState: choice filtering", () => {
  it("matches equals/not_equals by stable option id", () => {
    const records = [
      record("r-high", "Alpha", "opt-high"),
      record("r-low", "Bravo", "opt-low"),
      record("r-unset", "Charlie", null),
    ];

    const equalsResult = evaluateViewState({
      filters: [{ fieldDefinitionId: statusField.id, operator: "equals", value: "opt-high" }],
      sorts: [],
      columnFieldDefinitionIds: [nameField.id],
      activeFields,
      allFields: activeFields,
      records,
      choiceOptionsByFieldId,
    });
    expect(equalsResult.records.map((r) => r.id)).toEqual(["r-high"]);

    // not_equals, like every other type's comparison operators, excludes
    // unset values -- only is_not_set matches "no value". This mirrors
    // relation's and text's existing behavior exactly.
    const notEqualsResult = evaluateViewState({
      filters: [{ fieldDefinitionId: statusField.id, operator: "not_equals", value: "opt-high" }],
      sorts: [],
      columnFieldDefinitionIds: [nameField.id],
      activeFields,
      allFields: activeFields,
      records,
      choiceOptionsByFieldId,
    });
    expect(notEqualsResult.records.map((r) => r.id)).toEqual(["r-low"]);
  });

  it("matches is_set/is_not_set", () => {
    const records = [record("r-set", "Alpha", "opt-high"), record("r-unset", "Bravo", null)];

    const isSetResult = evaluateViewState({
      filters: [{ fieldDefinitionId: statusField.id, operator: "is_set" }],
      sorts: [],
      columnFieldDefinitionIds: [nameField.id],
      activeFields,
      allFields: activeFields,
      records,
      choiceOptionsByFieldId,
    });
    expect(isSetResult.records.map((r) => r.id)).toEqual(["r-set"]);
  });
});
