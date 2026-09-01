import { describe, expect, it } from "vitest";
import {
  cycleSortForField,
  hasPendingViewParams,
  isSameViewState,
  rawSearchParamsToUrlSearchParams,
  searchParamsToFormData,
  serializeViewState,
  withoutViewStateParams,
  withViewStateParams,
} from "./view-query-state";

describe("rawSearchParamsToUrlSearchParams", () => {
  it("flattens single and array values into a URLSearchParams", () => {
    const params = rawSearchParamsToUrlSearchParams({
      view: "all",
      columnFieldDefinitionId: ["f1", "f2"],
      showArchived: undefined,
    });

    expect(params.get("view")).toBe("all");
    expect(params.getAll("columnFieldDefinitionId")).toEqual(["f1", "f2"]);
    expect(params.has("showArchived")).toBe(false);
  });
});

describe("hasPendingViewParams", () => {
  it("is false when no view-state keys are present", () => {
    expect(hasPendingViewParams({ view: "abc", showArchived: "true" })).toBe(false);
  });

  it("is true when an indexed filter key is present", () => {
    expect(hasPendingViewParams({ "filterField:0": "field-1" })).toBe(true);
  });

  it("is true when an indexed sort key is present", () => {
    expect(hasPendingViewParams({ "sortDirection:2": "desc" })).toBe(true);
  });

  it("is true when a column key is present", () => {
    expect(hasPendingViewParams({ columnFieldDefinitionId: ["a", "b"] })).toBe(true);
  });

  it("ignores unrelated keys that merely start similarly", () => {
    expect(hasPendingViewParams({ filterFieldish: "nope" })).toBe(false);
  });
});

describe("searchParamsToFormData", () => {
  it("appends single string values", () => {
    const formData = searchParamsToFormData({ "filterField:0": "field-1" });
    expect(formData.get("filterField:0")).toBe("field-1");
  });

  it("appends every entry of an array value under the same key", () => {
    const formData = searchParamsToFormData({
      columnFieldDefinitionId: ["field-1", "field-2"],
    });
    expect(formData.getAll("columnFieldDefinitionId")).toEqual(["field-1", "field-2"]);
  });

  it("skips undefined values", () => {
    const formData = searchParamsToFormData({ view: undefined, showArchived: "true" });
    expect(formData.get("view")).toBeNull();
    expect(formData.get("showArchived")).toBe("true");
  });
});

describe("serializeViewState / withViewStateParams round-trip", () => {
  it("serializes filters, sorts, and columns using the form field-name convention", () => {
    const entries = serializeViewState({
      filters: [{ fieldDefinitionId: "f1", operator: "equals", value: "Acme" }],
      sorts: [{ fieldDefinitionId: "f2", direction: "desc" }],
      columnFieldDefinitionIds: ["f1", "f2"],
    });

    expect(entries).toEqual([
      ["filterField:0", "f1"],
      ["filterOperator:0", "equals"],
      ["filterValue:0", "Acme"],
      ["sortField:0", "f2"],
      ["sortDirection:0", "desc"],
      ["columnFieldDefinitionId", "f1"],
      ["columnFieldDefinitionId", "f2"],
    ]);
  });

  it("omits the value entry for operators that don't need one", () => {
    const entries = serializeViewState({
      filters: [{ fieldDefinitionId: "f1", operator: "is_set" }],
      sorts: [],
      columnFieldDefinitionIds: [],
    });

    expect(entries).toEqual([
      ["filterField:0", "f1"],
      ["filterOperator:0", "is_set"],
    ]);
  });

  it("replaces prior pending params rather than accumulating them", () => {
    const current = new URLSearchParams(
      "view=all&filterField:0=old&filterOperator:0=equals&filterValue:0=x",
    );
    const next = withViewStateParams(
      current,
      serializeViewState({
        filters: [{ fieldDefinitionId: "new-field", operator: "equals", value: "y" }],
        sorts: [],
        columnFieldDefinitionIds: [],
      }),
    );

    expect(next.get("view")).toBe("all");
    expect(next.get("filterField:0")).toBe("new-field");
    expect(next.get("filterValue:0")).toBe("y");
  });

  it("clears all pending params when given an empty entry list", () => {
    const current = new URLSearchParams("view=all&filterField:0=old&columnFieldDefinitionId=a");
    const next = withViewStateParams(current, []);

    expect(next.get("view")).toBe("all");
    expect(next.has("filterField:0")).toBe(false);
    expect(next.has("columnFieldDefinitionId")).toBe(false);
  });
});

describe("withoutViewStateParams", () => {
  it("strips pending view params and the saveView flag, keeping everything else", () => {
    const current = new URLSearchParams(
      "view=my-view&manage=true&filterField:0=f1&sortField:0=f2&columnFieldDefinitionId=f1&saveView=true",
    );
    const next = withoutViewStateParams(current);

    expect(next.get("view")).toBe("my-view");
    expect(next.get("manage")).toBe("true");
    expect(next.has("filterField:0")).toBe(false);
    expect(next.has("sortField:0")).toBe(false);
    expect(next.has("columnFieldDefinitionId")).toBe(false);
    expect(next.has("saveView")).toBe(false);
  });
});

describe("isSameViewState", () => {
  it("is true for two states with identical filters, sorts, and columns", () => {
    const state = {
      filters: [{ fieldDefinitionId: "f1", operator: "equals" as const, value: "x" }],
      sorts: [{ fieldDefinitionId: "f2", direction: "asc" as const }],
      columnFieldDefinitionIds: ["f1", "f2"],
    };
    expect(isSameViewState(state, { ...state })).toBe(true);
  });

  it("is true when both states have empty filters/sorts but the same columns -- the case that would otherwise leave a stale 'unsaved changes' banner after cycling a sort back to none", () => {
    const a = { filters: [], sorts: [], columnFieldDefinitionIds: ["f1", "f2"] };
    const b = { filters: [], sorts: [], columnFieldDefinitionIds: ["f1", "f2"] };
    expect(isSameViewState(a, b)).toBe(true);
  });

  it("is false when a filter value differs", () => {
    const a = {
      filters: [{ fieldDefinitionId: "f1", operator: "equals" as const, value: "x" }],
      sorts: [],
      columnFieldDefinitionIds: [],
    };
    const b = {
      filters: [{ fieldDefinitionId: "f1", operator: "equals" as const, value: "y" }],
      sorts: [],
      columnFieldDefinitionIds: [],
    };
    expect(isSameViewState(a, b)).toBe(false);
  });

  it("is false when column order differs", () => {
    const a = { filters: [], sorts: [], columnFieldDefinitionIds: ["f1", "f2"] };
    const b = { filters: [], sorts: [], columnFieldDefinitionIds: ["f2", "f1"] };
    expect(isSameViewState(a, b)).toBe(false);
  });
});

describe("cycleSortForField", () => {
  it("starts a fresh column at ascending when nothing is currently sorted", () => {
    expect(cycleSortForField({ currentSorts: [], fieldId: "f1" })).toEqual([
      { fieldDefinitionId: "f1", direction: "asc" },
    ]);
  });

  it("moves ascending to descending on the same sole column", () => {
    const currentSorts = [{ fieldDefinitionId: "f1", direction: "asc" as const }];
    expect(cycleSortForField({ currentSorts, fieldId: "f1" })).toEqual([
      { fieldDefinitionId: "f1", direction: "desc" },
    ]);
  });

  it("clears the sort when descending is clicked again", () => {
    const currentSorts = [{ fieldDefinitionId: "f1", direction: "desc" as const }];
    expect(cycleSortForField({ currentSorts, fieldId: "f1" })).toEqual([]);
  });

  it("replaces a different column's sort by starting the clicked column at ascending", () => {
    const currentSorts = [{ fieldDefinitionId: "other", direction: "desc" as const }];
    expect(cycleSortForField({ currentSorts, fieldId: "f1" })).toEqual([
      { fieldDefinitionId: "f1", direction: "asc" },
    ]);
  });

  it("replaces a multi-column sort by starting the clicked column fresh at ascending", () => {
    const currentSorts = [
      { fieldDefinitionId: "f1", direction: "asc" as const },
      { fieldDefinitionId: "f2", direction: "desc" as const },
    ];
    expect(cycleSortForField({ currentSorts, fieldId: "f1" })).toEqual([
      { fieldDefinitionId: "f1", direction: "asc" },
    ]);
  });
});
