// Empty-state precedence for the entity records table (Phase 9.4). Decides
// which of four distinct, truthful messages to show when the rendered table
// has zero rows -- distinguishing the underlying object state (does
// anything exist at all? is everything archived and currently hidden?)
// from the evaluated/view-filtered result, so the message is never a
// generic "no records yet" when records genuinely exist but are filtered or
// archived out of view.

export type TableEmptyStateAction = {
  label: string;
  href: string;
};

export type TableEmptyState = {
  title: string;
  description: string;
  action?: TableEmptyStateAction;
};

export function resolveTableEmptyState({
  entityName,
  evaluatedRecordCount,
  activeRecordCount,
  totalRecordCount,
  showArchivedRecords,
  hasPendingViewEdits,
  selectedViewName,
  showArchivedHref,
  clearFiltersHref,
}: {
  entityName: string;
  // evaluatedView.records.length -- the final, view-filtered/sorted count
  // actually rendered.
  evaluatedRecordCount: number;
  // records.length -- the count before view-level filters are applied, in
  // the *current* archived-visibility mode (so this already excludes
  // archived records when showArchivedRecords is false).
  activeRecordCount: number;
  // The true total record count regardless of archived state. Only needed
  // (and only ever fetched by the caller) when activeRecordCount is 0 and
  // showArchivedRecords is false -- undefined otherwise, treated
  // conservatively (never asserts records are archived without evidence).
  totalRecordCount?: number;
  showArchivedRecords: boolean;
  hasPendingViewEdits: boolean;
  selectedViewName?: string;
  showArchivedHref: string;
  clearFiltersHref: string;
}): TableEmptyState | undefined {
  if (evaluatedRecordCount > 0) {
    return undefined;
  }

  const genericEmptyState: TableEmptyState = {
    title: `No ${entityName.toLowerCase()} records yet.`,
    description: `Add the first ${entityName.toLowerCase()} to get started.`,
  };

  if (activeRecordCount === 0) {
    // Nothing in the current archived-visibility mode. Hidden archived
    // records alone don't make this "no records yet" -- only claim that
    // once totalRecordCount confirms nothing exists at all.
    if (!showArchivedRecords && (totalRecordCount ?? 0) > 0) {
      return {
        title: "All records are archived.",
        description: `Every ${entityName.toLowerCase()} record has been archived. Show archived records to see them.`,
        action: { label: "Show archived records", href: showArchivedHref },
      };
    }

    return genericEmptyState;
  }

  // activeRecordCount > 0 but evaluatedRecordCount === 0: a filter, not the
  // underlying data, produced zero rows.
  if (hasPendingViewEdits) {
    // An unsaved quick-bar filter takes precedence over a saved view's own
    // filters below, since the pending edit is what's actually governing
    // the current result.
    return {
      title: "No records match your current filters.",
      description: "Clear your current filters to see all records.",
      action: { label: "Clear filters", href: clearFiltersHref },
    };
  }

  if (selectedViewName) {
    return {
      title: `No records match ${selectedViewName}.`,
      description: "Try another view or add a record that matches this view.",
    };
  }

  // Unreachable in practice (no filters at all implies
  // evaluatedRecordCount === activeRecordCount), kept only as a truthful
  // fallback rather than an unhandled case.
  return genericEmptyState;
}
