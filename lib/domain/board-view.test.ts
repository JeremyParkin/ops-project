import { describe, expect, it } from "vitest";
import { buildBoardLanes } from "./board-view";
import type { ChoiceOption, EntityRecord, FieldDefinition } from "./types";

function field(overrides: Partial<FieldDefinition> = {}): FieldDefinition {
  return {
    id: "status-field",
    workspaceId: "workspace-1",
    entityTypeId: "entity-1",
    key: "status",
    name: "Status",
    slug: "status",
    type: "choice",
    required: false,
    position: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function option(id: string, position: number, archived = false): ChoiceOption {
  return {
    id,
    workspaceId: "workspace-1",
    fieldDefinitionId: "status-field",
    label: id,
    color: "gray",
    position,
    archivedAt: archived ? "2026-01-01T00:00:00.000Z" : undefined,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function record(id: string, status: string | null): EntityRecord {
  return {
    id,
    workspaceId: "workspace-1",
    entityTypeId: "entity-1",
    values: { status },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("buildBoardLanes", () => {
  it("creates active lanes in configured option order, including empty lanes", () => {
    const lanes = buildBoardLanes({
      field: field(),
      options: [option("later", 2), option("now", 1), option("empty", 3)],
      records: [record("record-1", "later"), record("record-2", "now")],
    });

    expect(lanes.map((lane) => lane.id)).toEqual(["now", "later", "empty", "unset"]);
    expect(lanes.map((lane) => lane.records.map((row) => row.id))).toEqual([
      ["record-2"],
      ["record-1"],
      [],
      [],
    ]);
  });

  it("renders Unset only for optional fields", () => {
    expect(
      buildBoardLanes({
        field: field({ required: false }),
        options: [option("todo", 1)],
        records: [record("record-1", null)],
      }).map((lane) => lane.id),
    ).toEqual(["todo", "unset"]);

    expect(
      buildBoardLanes({
        field: field({ required: true }),
        options: [option("todo", 1)],
        records: [record("record-1", null)],
      }).map((lane) => lane.id),
    ).toEqual(["todo"]);
  });

  it("adds distinct populated archived lanes and omits empty archived lanes", () => {
    const lanes = buildBoardLanes({
      field: field(),
      options: [
        option("active", 1),
        option("old-empty", 2, true),
        option("old-held", 3, true),
      ],
      records: [record("record-1", "old-held")],
    });

    expect(lanes.map((lane) => lane.id)).toEqual(["active", "unset", "old-held"]);
    expect(lanes.at(-1)?.records.map((row) => row.id)).toEqual(["record-1"]);
  });

  it("preserves evaluated input order within each lane", () => {
    const lanes = buildBoardLanes({
      field: field(),
      options: [option("todo", 1), option("done", 2)],
      records: [
        record("record-3", "todo"),
        record("record-1", "done"),
        record("record-2", "todo"),
      ],
    });

    expect(lanes[0].records.map((row) => row.id)).toEqual(["record-3", "record-2"]);
    expect(lanes[1].records.map((row) => row.id)).toEqual(["record-1"]);
  });

  it("groups records with archived values correctly", () => {
    const lanes = buildBoardLanes({
      field: field(),
      options: [option("active", 1), option("archived", 2, true)],
      records: [record("record-1", "archived"), record("record-2", "archived")],
    });

    expect(lanes.at(-1)).toMatchObject({
      kind: "archived",
      id: "archived",
    });
    expect(lanes.at(-1)?.records.map((row) => row.id)).toEqual(["record-1", "record-2"]);
  });
});
