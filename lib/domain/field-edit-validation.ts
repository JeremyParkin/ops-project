export type FieldEditFormState = {
  success: boolean;
  message: string;
  errors: Record<string, string>;
  values: {
    name: string;
    required: boolean;
  };
};

export function createInitialFieldEditFormState({
  name,
  required,
}: {
  name: string;
  required: boolean;
}): FieldEditFormState {
  return {
    success: false,
    message: "",
    errors: {},
    values: {
      name,
      required,
    },
  };
}

function getString(formData: FormData, key: string) {
  const value = formData.get(key);

  return typeof value === "string" ? value.trim() : "";
}

function getLastString(formData: FormData, key: string) {
  const values = formData.getAll(key);
  const value = values.at(-1);

  return typeof value === "string" ? value.trim() : "";
}

export function validateFieldEditFormData(formData: FormData):
  | {
      success: true;
      values: FieldEditFormState["values"];
    }
  | {
      success: false;
      state: FieldEditFormState;
    } {
  const values = {
    name: getString(formData, "fieldName"),
    required: getLastString(formData, "fieldRequired") === "true",
  };
  const errors: Record<string, string> = {};

  if (!values.name) {
    errors.fieldName = "Field name is required.";
  }

  if (Object.keys(errors).length > 0) {
    return {
      success: false,
      state: {
        success: false,
        message: "Please fix the highlighted fields.",
        errors,
        values,
      },
    };
  }

  return {
    success: true,
    values,
  };
}
