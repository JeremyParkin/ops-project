"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

type RecordSelectionContextValue = {
  selectedIds: Set<string>;
  toggle: (recordId: string) => void;
  setMany: (recordIds: string[], selected: boolean) => void;
  clear: () => void;
};

const RecordSelectionContext = createContext<RecordSelectionContextValue | null>(null);

// Selection is deliberately plain client state, not persisted anywhere (no
// URL param, no storage) -- "ephemeral, resets when the result set
// materially changes" per Phase 9.5.
//
// `resetKey` is the signal for that: the caller (entity-records-table.tsx)
// passes the current rendered record-id order, so a filter/sort/
// archived-toggle change (different ids or a different order) resets
// selection. This deliberately does NOT use React's `key` prop to force a
// remount -- a plain <Link> navigation to a new URL reconciles a stable
// client component in place rather than unmounting it (same as
// router.refresh() would), so a key change here would remount this whole
// subtree, including RecordBulkActionsBar's own useActionState result --
// wiping out a just-completed action's success/error message before it
// was ever shown, since that action is itself what just changed the
// record set. Instead, selectedIds is reset by comparing resetKey against
// its previous value during render (React's documented pattern for
// resetting one piece of state on a prop change without remounting
// anything) -- everything else in the tree, including the bulk bar's own
// state, is left untouched. Uses a paired useState, not a ref: this
// project's lint rules reject ref reads/writes during render (guarding
// against incompatibility with the React Compiler's assumptions), and
// React's own state updates are explicitly safe to read and trigger during
// render, which is what this pattern relies on.
export function RecordSelectionProvider({
  children,
  resetKey,
}: {
  children: ReactNode;
  resetKey: string;
}) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [previousResetKey, setPreviousResetKey] = useState(resetKey);

  if (previousResetKey !== resetKey) {
    setPreviousResetKey(resetKey);
    setSelectedIds(new Set());
  }

  const value = useMemo<RecordSelectionContextValue>(
    () => ({
      selectedIds,
      toggle: (recordId) => {
        setSelectedIds((current) => {
          const next = new Set(current);

          if (next.has(recordId)) {
            next.delete(recordId);
          } else {
            next.add(recordId);
          }

          return next;
        });
      },
      setMany: (recordIds, selected) => {
        setSelectedIds((current) => {
          const next = new Set(current);

          recordIds.forEach((recordId) => {
            if (selected) {
              next.add(recordId);
            } else {
              next.delete(recordId);
            }
          });

          return next;
        });
      },
      clear: () => setSelectedIds(new Set()),
    }),
    [selectedIds],
  );

  return (
    <RecordSelectionContext.Provider value={value}>{children}</RecordSelectionContext.Provider>
  );
}

export function useRecordSelection() {
  const context = useContext(RecordSelectionContext);

  if (!context) {
    throw new Error("useRecordSelection must be used within a RecordSelectionProvider");
  }

  return context;
}
