import { describe, expect, it } from "vitest";
import {
  activeChoiceOptions,
  resolveChoiceOption,
  sortChoiceOptionsByPosition,
  toChoiceOptionsByFieldKey,
} from "./choice-display";
import type { ChoiceOption, FieldDefinition } from "./types";

function option(id: string, position: number, archived = false): ChoiceOption {
  return {
    id,
    workspaceId: "ws-1",
    fieldDefinitionId: "field-1",
    label: id,
    position,
    archivedAt: archived ? "2026-02-01T00:00:00.000Z" : undefined,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("resolveChoiceOption", () => {
  const options = [option("a", 0), option("b", 1, true)];

  it("finds an option by id, active or archived", () => {
    expect(resolveChoiceOption(options, "a")?.id).toBe("a");
    expect(resolveChoiceOption(options, "b")?.id).toBe("b");
  });

  it("returns undefined for unset, empty, or non-string values", () => {
    expect(resolveChoiceOption(options, null)).toBeUndefined();
    expect(resolveChoiceOption(options, undefined)).toBeUndefined();
    expect(resolveChoiceOption(options, "")).toBeUndefined();
    expect(resolveChoiceOption(options, 42)).toBeUndefined();
  });

  it("returns undefined for a stale id matching no option", () => {
    expect(resolveChoiceOption(options, "nonexistent")).toBeUndefined();
  });
});

describe("sortChoiceOptionsByPosition / activeChoiceOptions", () => {
  it("sorts by position ascending without mutating the input", () => {
    const input = [option("c", 2), option("a", 0), option("b", 1)];
    const sorted = sortChoiceOptionsByPosition(input);

    expect(sorted.map((o) => o.id)).toEqual(["a", "b", "c"]);
    expect(input.map((o) => o.id)).toEqual(["c", "a", "b"]);
  });

  it("excludes archived options and keeps position order", () => {
    const input = [option("b", 1), option("a", 0, true), option("c", 2)];

    expect(activeChoiceOptions(input).map((o) => o.id)).toEqual(["b", "c"]);
  });
});

describe("toChoiceOptionsByFieldKey", () => {
  it("re-keys by field.key and includes only choice fields", () => {
    const choiceField: FieldDefinition = {
      id: "field-1",
      workspaceId: "ws-1",
      entityTypeId: "entity-1",
      key: "status",
      name: "Status",
      slug: "status",
      type: "choice",
      required: false,
      position: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const textField: FieldDefinition = { ...choiceField, id: "field-2", key: "name", type: "text" };
    const options = [option("a", 0)];

    const result = toChoiceOptionsByFieldKey([choiceField, textField], { "field-1": options });

    expect(result).toEqual({ status: options });
    expect(result.name).toBeUndefined();
  });

  it("defaults a choice field with no fetched options to an empty array", () => {
    const choiceField: FieldDefinition = {
      id: "field-1",
      workspaceId: "ws-1",
      entityTypeId: "entity-1",
      key: "status",
      name: "Status",
      slug: "status",
      type: "choice",
      required: false,
      position: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    expect(toChoiceOptionsByFieldKey([choiceField], {})).toEqual({ status: [] });
  });
});
