export type EntityMetadataFormState = {
  success: boolean;
  message: string;
  errors: Record<string, string>;
  values: {
    name: string;
    description: string;
  };
};

export function createInitialEntityMetadataFormState({
  name,
  description,
}: EntityMetadataFormState["values"]): EntityMetadataFormState {
  return {
    success: false,
    message: "",
    errors: {},
    values: {
      name,
      description,
    },
  };
}

function getString(formData: FormData, key: string) {
  const value = formData.get(key);

  return typeof value === "string" ? value.trim() : "";
}

export function validateEntityMetadataFormData(formData: FormData):
  | {
      success: true;
      values: EntityMetadataFormState["values"];
    }
  | {
      success: false;
      state: EntityMetadataFormState;
    } {
  const values = {
    name: getString(formData, "entityName"),
    description: getString(formData, "entityDescription"),
  };
  const errors: Record<string, string> = {};

  if (!values.name) {
    errors.entityName = "Entity name is required.";
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
