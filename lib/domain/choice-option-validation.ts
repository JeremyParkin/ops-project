import { isChoiceOptionColor } from "./choice-colors";

export type ChoiceOptionFormState = {
  success: boolean;
  message: string;
  errors: Record<string, string>;
  values: { label: string; color: string };
};

export function createInitialChoiceOptionFormState(
  values?: Partial<ChoiceOptionFormState["values"]>,
): ChoiceOptionFormState {
  return {
    success: false,
    message: "",
    errors: {},
    values: {
      label: values?.label ?? "",
      color: values?.color ?? "",
    },
  };
}

export function validateChoiceOptionFormData(formData: FormData):
  | { success: true; values: { label: string; color?: string } }
  | { success: false; errors: Record<string, string>; values: ChoiceOptionFormState["values"] } {
  const rawLabel = String(formData.get("optionLabel") ?? "");
  const rawColor = String(formData.get("optionColor") ?? "");
  const label = rawLabel.trim();
  const errors: Record<string, string> = {};

  if (!label) {
    errors.optionLabel = "Option label is required.";
  }

  if (rawColor !== "" && !isChoiceOptionColor(rawColor)) {
    errors.optionColor = "Choose one of the available colors.";
  }

  if (Object.keys(errors).length > 0) {
    return { success: false, errors, values: { label: rawLabel, color: rawColor } };
  }

  return {
    success: true,
    values: { label, color: rawColor === "" ? undefined : rawColor },
  };
}
