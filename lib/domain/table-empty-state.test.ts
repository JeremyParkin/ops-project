import { describe, expect, it } from "vitest";
import { resolveTableEmptyState } from "./table-empty-state";

const HREFS = {
  showArchivedHref: "/entities/e1?showArchived=true",
  clearFiltersHref: "/entities/e1",
};

describe("resolveTableEmptyState", () => {
  it("returns undefined when the evaluated view has rows", () => {
    expect(
      resolveTableEmptyState({
        entityName: "Deal",
        evaluatedRecordCount: 3,
        activeRecordCount: 3,
        showArchivedRecords: false,
        hasPendingViewEdits: false,
        ...HREFS,
      }),
    ).toBeUndefined();
  });

  it("state A: no records exist at all", () => {
    const state = resolveTableEmptyState({
      entityName: "Deal",
      evaluatedRecordCount: 0,
      activeRecordCount: 0,
      totalRecordCount: 0,
      showArchivedRecords: false,
      hasPendingViewEdits: false,
      ...HREFS,
    });
    expect(state).toEqual({
      title: "No deal records yet.",
      description: "Add the first deal to get started.",
    });
  });

  it("state A: archived records are already shown and nothing exists", () => {
    const state = resolveTableEmptyState({
      entityName: "Deal",
      evaluatedRecordCount: 0,
      activeRecordCount: 0,
      showArchivedRecords: true,
      hasPendingViewEdits: false,
      ...HREFS,
    });
    expect(state?.title).toBe("No deal records yet.");
    expect(state?.action).toBeUndefined();
  });

  it("state B: archived records exist, none active, archived hidden", () => {
    const state = resolveTableEmptyState({
      entityName: "Deal",
      evaluatedRecordCount: 0,
      activeRecordCount: 0,
      totalRecordCount: 5,
      showArchivedRecords: false,
      hasPendingViewEdits: false,
      ...HREFS,
    });
    expect(state).toEqual({
      title: "All records are archived.",
      description: "Every deal record has been archived. Show archived records to see them.",
      action: { label: "Show archived records", href: HREFS.showArchivedHref },
    });
  });

  it("does not infer 'all archived' when totalRecordCount is unknown (undefined)", () => {
    const state = resolveTableEmptyState({
      entityName: "Deal",
      evaluatedRecordCount: 0,
      activeRecordCount: 0,
      // totalRecordCount intentionally omitted
      showArchivedRecords: false,
      hasPendingViewEdits: false,
      ...HREFS,
    });
    expect(state?.title).toBe("No deal records yet.");
    expect(state?.action).toBeUndefined();
  });

  it("state C: unsaved quick-bar filter zeroes a nonempty active set", () => {
    const state = resolveTableEmptyState({
      entityName: "Deal",
      evaluatedRecordCount: 0,
      activeRecordCount: 4,
      showArchivedRecords: false,
      hasPendingViewEdits: true,
      selectedViewName: "My Deals",
      ...HREFS,
    });
    expect(state).toEqual({
      title: "No records match your current filters.",
      description: "Clear your current filters to see all records.",
      action: { label: "Clear filters", href: HREFS.clearFiltersHref },
    });
  });

  it("state C takes precedence over state D when both a saved view and pending edits are present", () => {
    const state = resolveTableEmptyState({
      entityName: "Deal",
      evaluatedRecordCount: 0,
      activeRecordCount: 4,
      showArchivedRecords: false,
      hasPendingViewEdits: true,
      selectedViewName: "My Deals",
      ...HREFS,
    });
    expect(state?.title).toBe("No records match your current filters.");
  });

  it("state D: a saved view's own filters zero a nonempty active set", () => {
    const state = resolveTableEmptyState({
      entityName: "Deal",
      evaluatedRecordCount: 0,
      activeRecordCount: 4,
      showArchivedRecords: false,
      hasPendingViewEdits: false,
      selectedViewName: "My Deals",
      ...HREFS,
    });
    expect(state).toEqual({
      title: "No records match My Deals.",
      description: "Try another view or add a record that matches this view.",
    });
  });

  it("falls back to the generic empty state when no filter/view explains a zero-result evaluated view", () => {
    const state = resolveTableEmptyState({
      entityName: "Deal",
      evaluatedRecordCount: 0,
      activeRecordCount: 4,
      showArchivedRecords: false,
      hasPendingViewEdits: false,
      ...HREFS,
    });
    expect(state?.title).toBe("No deal records yet.");
  });
});
