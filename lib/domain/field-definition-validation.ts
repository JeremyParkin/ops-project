import type { FieldType } from "./types";

const fieldTypes = new Set<FieldType>([
  "text",
  "number",
  "date",
  "boolean",
  "relation",
  "choice",
]);

export type FieldDefinitionFormState = {
  success: boolean;
  message: string;
  errors: Record<string, string>;
  values: {
    name: string;
    type: FieldType;
    relatedEntityTypeId: string;
    required: boolean;
  };
};

export type ValidatedFieldDefinition = FieldDefinitionFormState["values"];

export const initialFieldDefinitionFormState: FieldDefinitionFormState = {
  success: false,
  message: "",
  errors: {},
  values: {
    name: "",
    type: "text",
    relatedEntityTypeId: "",
    required: false,
  },
};

function getString(formData: FormData, key: string) {
  const value = formData.get(key);

  return typeof value === "string" ? value.trim() : "";
}

function getLastString(formData: FormData, key: string) {
  const values = formData.getAll(key);
  const value = values.at(-1);

  return typeof value === "string" ? value.trim() : "";
}

export function validateFieldDefinitionFormData(
  formData: FormData,
):
  | {
      success: true;
      field: ValidatedFieldDefinition;
    }
  | {
      success: false;
      state: FieldDefinitionFormState;
    } {
  const submittedType = getString(formData, "fieldType");
  const type = fieldTypes.has(submittedType as FieldType)
    ? (submittedType as FieldType)
    : "text";
  const values = {
    name: getString(formData, "fieldName"),
    type,
    relatedEntityTypeId: getString(formData, "fieldRelatedEntityTypeId"),
    required: getLastString(formData, "fieldRequired") === "true",
  };
  const errors: Record<string, string> = {};

  if (!values.name) {
    errors.fieldName = "Field name is required.";
  }

  if (!fieldTypes.has(submittedType as FieldType)) {
    errors.fieldType = "Choose a supported field type.";
  }

  if (values.type === "relation" && !values.relatedEntityTypeId) {
    errors.fieldRelatedEntityTypeId = "Choose a related entity.";
  }

  if (values.type !== "relation") {
    values.relatedEntityTypeId = "";
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
    field: values,
  };
}
