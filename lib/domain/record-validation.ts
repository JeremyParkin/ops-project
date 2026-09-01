import type {
  EntityRecord,
  FieldDefinition,
  FieldValue,
} from "./types";

export type RecordFormState = {
  success: boolean;
  message: string;
  errors: Record<string, string>;
  values: Record<string, string>;
};

export const initialRecordFormState: RecordFormState = {
  success: false,
  message: "",
  errors: {},
  values: {},
};

type ValidationResult =
  | {
      success: true;
      values: EntityRecord["values"];
      submittedValues: Record<string, string>;
    }
  | {
      success: false;
      errors: Record<string, string>;
      submittedValues: Record<string, string>;
    };

type RelationValueValidator = (
  field: FieldDefinition,
  value: string,
) => Promise<boolean>;

// Mirrors RelationValueValidator: checks the option belongs to this exact
// field (workspace + field-scoped). Archived options are valid here --
// this is app-layer UX validation, not the "must be active" boundary; that
// preserve-vs-assign distinction is enforced at the RPC layer (migration
// 0080), which is the actual authority.
type ChoiceValueValidator = (
  field: FieldDefinition,
  optionId: string,
) => Promise<boolean>;

type RecordValuesValidationResult =
  | {
      success: true;
      values: EntityRecord["values"];
    }
  | {
      success: false;
      errors: Record<string, string>;
    };

function getSubmittedValue(formData: FormData, field: FieldDefinition) {
  const values = formData.getAll(field.key);
  const value = values.at(-1);

  if (value === undefined) {
    return "";
  }

  return typeof value === "string" ? value.trim() : "";
}

export function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

export function isValidDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  return !Number.isNaN(date.valueOf()) && date.toISOString().startsWith(value);
}

function parseFieldValue(
  field: FieldDefinition,
  rawValue: string,
): { value: FieldValue } | { error: string } {
  if (rawValue === "") {
    if (field.required) {
      return { error: `${field.name} is required.` };
    }

    return { value: null };
  }

  switch (field.type) {
    case "text":
      return { value: rawValue };
    case "number": {
      const parsedValue = Number(rawValue);

      if (Number.isNaN(parsedValue)) {
        return { error: `${field.name} must be a number.` };
      }

      return { value: parsedValue };
    }
    case "date":
      if (!isValidDate(rawValue)) {
        return { error: `${field.name} must be a valid date.` };
      }

      return { value: rawValue };
    case "boolean":
      if (rawValue === "true" || rawValue === "on" || rawValue === "1") {
        return { value: true };
      }

      if (rawValue === "false" || rawValue === "off" || rawValue === "0") {
        return { value: false };
      }

      return { error: `${field.name} must be true or false.` };
    case "relation":
      if (!field.relatedEntityTypeId) {
        return { error: `${field.name} is missing relation metadata.` };
      }

      if (!isUuid(rawValue)) {
        return { error: `${field.name} must reference a valid record.` };
      }

      return { value: rawValue };
    case "choice":
      if (!isUuid(rawValue)) {
        return { error: `${field.name} must reference a valid option.` };
      }

      return { value: rawValue };
  }
}

export async function validateRecordFormData(
  fields: FieldDefinition[],
  formData: FormData,
  validateRelationValue?: RelationValueValidator,
  validateChoiceValue?: ChoiceValueValidator,
): Promise<ValidationResult> {
  const fieldKeys = new Set(fields.map((field) => field.key));
  const errors: Record<string, string> = {};
  const recordValues: EntityRecord["values"] = {};
  const submittedValues: Record<string, string> = {};

  for (const key of formData.keys()) {
    if (
      !key.startsWith("$ACTION_") &&
      key !== "returnTo" &&
      !fieldKeys.has(key)
    ) {
      errors._form = "The submission included an unknown field.";
    }
  }

  for (const field of fields) {
    const rawValue = getSubmittedValue(formData, field);
    submittedValues[field.key] = rawValue;

    const parsedValue = parseFieldValue(field, rawValue);

    if ("error" in parsedValue) {
      errors[field.key] = parsedValue.error;
    } else {
      if (
        field.type === "relation" &&
        parsedValue.value !== null &&
        typeof parsedValue.value === "string" &&
        validateRelationValue
      ) {
        const isValidRelation = await validateRelationValue(
          field,
          parsedValue.value,
        );

        if (!isValidRelation) {
          errors[field.key] = `${field.name} must reference an existing record.`;
          continue;
        }
      }

      if (
        field.type === "choice" &&
        parsedValue.value !== null &&
        typeof parsedValue.value === "string" &&
        validateChoiceValue
      ) {
        const isValidChoice = await validateChoiceValue(field, parsedValue.value);

        if (!isValidChoice) {
          errors[field.key] = `${field.name} must reference a valid option.`;
          continue;
        }
      }

      recordValues[field.key] = parsedValue.value;
    }
  }

  if (Object.keys(errors).length > 0) {
    return {
      success: false,
      errors,
      submittedValues,
    };
  }

  return {
    success: true,
    values: recordValues,
    submittedValues,
  };
}

export async function validateRecordValues(
  fields: FieldDefinition[],
  values: EntityRecord["values"],
  validateRelationValue?: RelationValueValidator,
  validateChoiceValue?: ChoiceValueValidator,
): Promise<RecordValuesValidationResult> {
  const errors: Record<string, string> = {};
  const recordValues: EntityRecord["values"] = {};
  const fieldKeys = new Set(fields.map((field) => field.key));

  Object.keys(values).forEach((key) => {
    if (!fieldKeys.has(key)) {
      errors._form = "The record included an unknown field.";
    }
  });

  for (const field of fields) {
    const value = values[field.key];

    if (value === undefined || value === null || value === "") {
      if (field.required) {
        errors[field.key] = `${field.name} is required.`;
      } else if (value !== undefined) {
        recordValues[field.key] = null;
      }

      continue;
    }

    switch (field.type) {
      case "text":
        if (typeof value !== "string") {
          errors[field.key] = `${field.name} must be text.`;
        } else {
          recordValues[field.key] = value;
        }
        break;
      case "number":
        if (typeof value !== "number" || Number.isNaN(value)) {
          errors[field.key] = `${field.name} must be a number.`;
        } else {
          recordValues[field.key] = value;
        }
        break;
      case "date":
        if (typeof value !== "string" || !isValidDate(value)) {
          errors[field.key] = `${field.name} must be a valid date.`;
        } else {
          recordValues[field.key] = value;
        }
        break;
      case "boolean":
        if (typeof value !== "boolean") {
          errors[field.key] = `${field.name} must be true or false.`;
        } else {
          recordValues[field.key] = value;
        }
        break;
      case "relation":
        if (!field.relatedEntityTypeId) {
          errors[field.key] = `${field.name} is missing relation metadata.`;
          break;
        }

        if (typeof value !== "string" || !isUuid(value)) {
          errors[field.key] = `${field.name} must reference a valid record.`;
          break;
        }

        if (
          validateRelationValue &&
          !(await validateRelationValue(field, value))
        ) {
          errors[field.key] = `${field.name} must reference an existing record.`;
          break;
        }

        recordValues[field.key] = value;
        break;
      case "choice":
        if (typeof value !== "string" || !isUuid(value)) {
          errors[field.key] = `${field.name} must reference a valid option.`;
          break;
        }

        if (
          validateChoiceValue &&
          !(await validateChoiceValue(field, value))
        ) {
          errors[field.key] = `${field.name} must reference a valid option.`;
          break;
        }

        recordValues[field.key] = value;
        break;
    }
  }

  if (Object.keys(errors).length > 0) {
    return {
      success: false,
      errors,
    };
  }

  return {
    success: true,
    values: recordValues,
  };
}
