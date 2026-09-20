import type { FieldType } from "./types";
import { isChoiceOptionColor } from "./choice-colors";

const fieldTypes = new Set<FieldType>([
  "text",
  "number",
  "date",
  "boolean",
  "relation",
  "choice",
  "workspace_member",
]);

export type EntityChoiceOptionFormRow = {
  rowId: string;
  label: string;
  color: string;
};

export type EntityFieldFormRow = {
  rowId: string;
  name: string;
  type: FieldType;
  relatedEntityTypeId: string;
  required: boolean;
  choiceOptions: EntityChoiceOptionFormRow[];
};

export type EntityDefinitionFormState = {
  success: boolean;
  formVersion: number;
  message: string;
  errors: Record<string, string>;
  entity: {
    name: string;
    description: string;
  };
  fields: EntityFieldFormRow[];
};

export type ValidatedEntityDefinition = {
  name: string;
  description: string;
  fields: EntityFieldFormRow[];
};

export const initialEntityDefinitionFormState: EntityDefinitionFormState = {
  success: false,
  formVersion: 0,
  message: "",
  errors: {},
  entity: {
    name: "",
    description: "",
  },
  fields: [
    {
      rowId: "field-1",
      name: "",
      type: "text",
      relatedEntityTypeId: "",
      required: false,
      choiceOptions: [],
    },
  ],
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

function getFieldRows(formData: FormData) {
  return formData
    .getAll("fieldRowId")
    .filter((value): value is string => typeof value === "string")
    .map((rowId) => {
      const type = getString(formData, `fieldType:${rowId}`);
      const choiceOptions = formData
        .getAll(`choiceOptionRowId:${rowId}`)
        .filter((value): value is string => typeof value === "string")
        .map((optionRowId) => ({
          rowId: optionRowId,
          label: getString(formData, `choiceOptionLabel:${rowId}:${optionRowId}`),
          color: getString(formData, `choiceOptionColor:${rowId}:${optionRowId}`),
        }));

      return {
        rowId,
        name: getString(formData, `fieldName:${rowId}`),
        type: fieldTypes.has(type as FieldType)
          ? (type as FieldType)
          : "text",
        relatedEntityTypeId: getString(formData, `fieldRelatedEntityTypeId:${rowId}`),
        required: getLastString(formData, `fieldRequired:${rowId}`) === "true",
        choiceOptions,
        submittedType: type,
      };
    });
}

export function validateEntityDefinitionFormData(
  formData: FormData,
  formVersion: number,
):
  | {
      success: true;
      definition: ValidatedEntityDefinition;
    }
  | {
      success: false;
      state: EntityDefinitionFormState;
    } {
  const errors: Record<string, string> = {};
  const entity = {
    name: getString(formData, "entityName"),
    description: getString(formData, "entityDescription"),
  };
  const submittedFields = getFieldRows(formData);
  const fields = submittedFields.map((field) => {
    return {
      rowId: field.rowId,
      name: field.name,
      type: field.type,
      relatedEntityTypeId: field.relatedEntityTypeId,
      required: field.required,
      choiceOptions: field.type === "choice" ? field.choiceOptions : [],
    };
  });

  if (!entity.name) {
    errors.entityName = "Name is required.";
  }

  if (fields.length === 0) {
    errors._form = "Add at least one field.";
  }

  submittedFields.forEach((field, index) => {
    if (!field.name) {
      errors[`fieldName:${field.rowId}`] = "Field name is required.";
    }

    if (!fieldTypes.has(field.submittedType as FieldType)) {
      errors[`fieldType:${field.rowId}`] = "Choose a supported field type.";
    }

    if (field.type === "relation" && !field.relatedEntityTypeId) {
      errors[`fieldRelatedEntityTypeId:${field.rowId}`] =
        "Choose a related entity.";
    }

    if (field.type === "choice") {
      const labels = new Set<string>();

      field.choiceOptions.forEach((option) => {
        const normalizedLabel = option.label.toLocaleLowerCase();

        if (!option.label) {
          errors[`choiceOptionLabel:${field.rowId}:${option.rowId}`] =
            "Option label is required.";
        } else if (labels.has(normalizedLabel)) {
          errors[`choiceOptionLabel:${field.rowId}:${option.rowId}`] =
            "Option labels must be unique.";
        } else {
          labels.add(normalizedLabel);
        }

        if (option.color !== "" && !isChoiceOptionColor(option.color)) {
          errors[`choiceOptionColor:${field.rowId}:${option.rowId}`] =
            "Choose one of the available colors.";
        }
      });
    }

    fields[index] = {
      rowId: field.rowId,
      name: field.name,
      type: field.type,
      relatedEntityTypeId: field.relatedEntityTypeId,
      required: field.required,
      choiceOptions: field.type === "choice" ? field.choiceOptions : [],
    };
  });

  if (Object.keys(errors).length > 0) {
    return {
      success: false,
      state: {
        success: false,
        formVersion,
        message: "Please fix the highlighted fields.",
        errors,
        entity,
        fields:
          fields.length > 0 ? fields : initialEntityDefinitionFormState.fields,
      },
    };
  }

  return {
    success: true,
    definition: {
      ...entity,
      fields,
    },
  };
}
