"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import type { RecordFieldFormState } from "@/app/actions";

type MoveDestination = {
  value: string;
  label: string;
};

type MoveAction = (
  state: RecordFieldFormState,
  formData: FormData,
) => Promise<RecordFieldFormState>;

const initialState: RecordFieldFormState = {
  success: false,
  message: "",
  value: "",
};

const unsetDestinationValue = "__unset__";

export function EntityBoardMoveForm({
  fieldKey,
  destinations,
  moveAction,
}: {
  fieldKey: string;
  destinations: MoveDestination[];
  moveAction: MoveAction;
}) {
  const [state, action, pending] = useActionState(moveAction, initialState);
  const [selectedValue, setSelectedValue] = useState("");
  const selectId = useId();
  const selectRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    if (state.message || state.success) {
      selectRef.current?.focus();
    }
  }, [state.message, state.success]);

  if (destinations.length === 0) {
    return null;
  }

  return (
    <form action={action} className="mt-3 grid gap-2">
      <input type="hidden" name="fieldKey" value={fieldKey} />
      <input
        type="hidden"
        name="value"
        value={selectedValue === unsetDestinationValue ? "" : selectedValue}
      />
      <label htmlFor={selectId} className="text-xs font-medium text-stone">
        Move to
      </label>
      <div className="flex gap-2">
        <select
          ref={selectRef}
          id={selectId}
          value={selectedValue}
          onChange={(event) => setSelectedValue(event.target.value)}
          disabled={pending}
          className="min-w-0 flex-1 border border-border bg-surface px-2 py-1.5 text-sm text-foreground disabled:cursor-not-allowed disabled:bg-background disabled:text-muted"
        >
          <option value="" disabled>
            Choose lane
          </option>
          {destinations.map((destination) => (
            <option
              key={destination.value || unsetDestinationValue}
              value={destination.value || unsetDestinationValue}
            >
              {destination.label}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={pending || selectedValue === ""}
          className="inline-flex h-9 items-center justify-center border border-border bg-surface px-3 text-sm font-medium text-muted hover:bg-background hover:text-foreground disabled:cursor-not-allowed disabled:bg-background disabled:text-muted"
        >
          {pending ? "Moving..." : "Move"}
        </button>
      </div>
      {state.message && !state.success ? (
        <p className="text-xs text-red-700" role="alert">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
