"use client";

import { useRecordSelection } from "@/app/components/record-selection-context";

export function RecordSelectionCheckbox({
  recordId,
  recordLabel,
}: {
  recordId: string;
  recordLabel: string;
}) {
  const { selectedIds, toggle } = useRecordSelection();

  return (
    <input
      type="checkbox"
      checked={selectedIds.has(recordId)}
      onChange={() => toggle(recordId)}
      aria-label={`Select ${recordLabel}`}
      className="h-4 w-4"
    />
  );
}
