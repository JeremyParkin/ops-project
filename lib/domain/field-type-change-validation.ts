// Plain (non-"use server") module for field type-change UI state -- kept
// out of app/actions.ts because a "use server" file may only export async
// functions; a plain constant/type export there fails the Next.js build
// ("A 'use server' file can only export async functions").
export type FieldTypeChangeDependencySummary = {
  recordValueCount: number;
  relationValueCount: number;
  choiceOptionCount: number;
  displayFieldReferenceCount: number;
  qualityReviewReferenceCount: number;
  peopleSensitiveReferenceCount: number;
  viewReferenceCount: number;
  workflowReferenceCount: number;
  processReferenceCount: number;
};

export type FieldTypeChangePreflightState = {
  checked: boolean;
  success: boolean;
  message: string;
  pristine: boolean;
  dependencies?: FieldTypeChangeDependencySummary;
};

export const initialFieldTypeChangePreflightState: FieldTypeChangePreflightState = {
  checked: false,
  success: false,
  message: "",
  pristine: false,
};

export type FieldTypeChangeActionState = {
  success: boolean;
  message: string;
  dependencies?: FieldTypeChangeDependencySummary;
};
