"use client";

import { useEffect, useRef } from "react";
import { useRecordSelection } from "@/app/components/record-selection-context";

// "Select all" means exactly the records currently rendered in the table --
// there is no pagination, so this is the complete evaluated result set, but
// the label and behavior describe "shown," never "matching this filter," so
// it stays truthful if pagination is ever introduced later.
export function RecordSelectionHeaderCheckbox({ recordIds }: { recordIds: string[] }) {
  const { selectedIds, setMany } = useRecordSelection();
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedShownCount = recordIds.filter((recordId) => selectedIds.has(recordId)).length;
  const allShownSelected = recordIds.length > 0 && selectedShownCount === recordIds.length;
  const isIndeterminate = selectedShownCount > 0 && !allShownSelected;

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = isIndeterminate;
    }
  }, [isIndeterminate]);

  return (
    <input
      ref={inputRef}
      type="checkbox"
      checked={allShownSelected}
      onChange={() => setMany(recordIds, !allShownSelected)}
      disabled={recordIds.length === 0}
      aria-label={
        allShownSelected
          ? `Deselect all ${recordIds.length} records shown`
          : `Select all ${recordIds.length} records shown`
      }
      className="h-4 w-4"
    />
  );
}
