import type { FieldDefinition, FieldValue } from "./types";
import { viewFilterNeedsValue } from "./view-engine";
import {
  FILTER_OPERATORS_BY_FIELD_TYPE,
  SORTABLE_FIELD_TYPES,
} from "./view-operators";
import type {
  ViewFilter,
  ViewFilterOperator,
  ViewSort,
  ViewSortDirection,
} from "./view-types";

export type ViewFormValues = {
  name: string;
  filters: ViewFilter[];
  sorts: ViewSort[];
  columnFieldDefinitionIds: string[];
  isDefault: boolean;
};

export type ViewFormState = {
  success: boolean;
  message: string;
  errors: Record<string, string>;
  values: ViewFormValues;
};

export function createInitialViewFormState(values?: Partial<ViewFormValues>): ViewFormState {
  return {
    success: false,
    message: "",
    errors: {},
    values: {
      name: values?.name ?? "",
      filters: values?.filters ?? [],
      sorts: values?.sorts ?? [],
      columnFieldDefinitionIds: values?.columnFieldDefinitionIds ?? [],
      isDefault: values?.isDefault ?? false,
    },
  };
}

function getLastFormString(formData: FormData, key: string) {
  const value = formData.getAll(key).at(-1);

  return typeof value === "string" ? value : "";
}

const operatorsByFieldType: Record<FieldDefinition["type"], ViewFilterOperator[]> =
  FILTER_OPERATORS_BY_FIELD_TYPE;

const sortableTypes = SORTABLE_FIELD_TYPES;

function isValidDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  return !Number.isNaN(date.valueOf()) && date.toISOString().startsWith(value);
}

function parseFilterValue({
  field,
  operator,
  rawValue,
}: {
  field: FieldDefinition;
  operator: ViewFilterOperator;
  rawValue: string;
}): { value?: FieldValue } | { error: string } {
  if (!viewFilterNeedsValue(operator)) {
    return {};
  }

  if (rawValue.trim() === "") {
    return { error: `${field.name} filter needs a value.` };
  }

  switch (field.type) {
    case "text":
    case "relation":
      return { value: rawValue.trim() };
    case "number": {
      const value = Number(rawValue);

      if (Number.isNaN(value)) {
        return { error: `${field.name} filter value must be a number.` };
      }

      return { value };
    }
    case "date":
      if (!isValidDate(rawValue.trim())) {
        return { error: `${field.name} filter value must be a valid date.` };
      }

      return { value: rawValue.trim() };
    case "boolean":
      if (rawValue === "true") {
        return { value: true };
      }

      if (rawValue === "false") {
        return { value: false };
      }

      return { error: `${field.name} filter value must be Yes or No.` };
  }
}

function getIndexedValues(formData: FormData, prefix: string) {
  return [...formData.keys()]
    .filter((key) => key.startsWith(prefix))
    .map((key) => Number(key.slice(prefix.length)))
    .filter((index) => Number.isInteger(index))
    .sort((left, right) => left - right);
}

export async function validateViewFormData({
  activeFields,
  allFields,
  formData,
  validateRelationValue,
}: {
  activeFields: FieldDefinition[];
  allFields: FieldDefinition[];
  formData: FormData;
  validateRelationValue: (
    field: FieldDefinition,
    recordId: string,
  ) => Promise<boolean>;
}): Promise<ViewFormState> {
  const activeFieldById = new Map(activeFields.map((field) => [field.id, field]));
  const allFieldById = new Map(allFields.map((field) => [field.id, field]));
  const errors: Record<string, string> = {};
  const name = String(formData.get("viewName") ?? "").trim();

  if (!name) {
    errors.viewName = "View name is required.";
  }

  const filters: ViewFilter[] = [];
  for (const index of getIndexedValues(formData, "filterField:")) {
    const fieldId = String(formData.get(`filterField:${index}`) ?? "");
    const operator = String(
      formData.get(`filterOperator:${index}`) ?? "",
    ) as ViewFilterOperator;
    const rawValue = String(formData.get(`filterValue:${index}`) ?? "");

    if (!fieldId && !operator && !rawValue) {
      continue;
    }

    const field = activeFieldById.get(fieldId);

    if (!field) {
      const staleField = allFieldById.get(fieldId);
      errors[`filterField:${index}`] = staleField?.archivedAt
        ? `${staleField.name} is archived. Remove or replace this filter.`
        : "Choose an active field for this filter.";
      continue;
    }

    if (!operatorsByFieldType[field.type].includes(operator)) {
      errors[`filterOperator:${index}`] = `${operator} is not valid for ${field.name}.`;
      continue;
    }

    const parsedValue = parseFilterValue({ field, operator, rawValue });

    if ("error" in parsedValue) {
      errors[`filterValue:${index}`] = parsedValue.error;
      continue;
    }

    if (
      field.type === "relation" &&
      typeof parsedValue.value === "string" &&
      !(await validateRelationValue(field, parsedValue.value))
    ) {
      errors[`filterValue:${index}`] = `${field.name} must reference an existing record.`;
      continue;
    }

    filters.push({
      fieldDefinitionId: field.id,
      operator,
      ...("value" in parsedValue ? { value: parsedValue.value } : {}),
    });
  }

  const sorts: ViewSort[] = [];
  for (const index of getIndexedValues(formData, "sortField:")) {
    const fieldId = String(formData.get(`sortField:${index}`) ?? "");
    const direction = String(
      formData.get(`sortDirection:${index}`) ?? "asc",
    ) as ViewSortDirection;

    if (!fieldId) {
      continue;
    }

    const field = activeFieldById.get(fieldId);

    if (!field) {
      errors[`sortField:${index}`] = "Choose an active field for this sort.";
      continue;
    }

    if (!sortableTypes.has(field.type)) {
      errors[`sortField:${index}`] = `${field.name} cannot be sorted in table views.`;
      continue;
    }

    sorts.push({
      fieldDefinitionId: field.id,
      direction: direction === "desc" ? "desc" : "asc",
    });
  }

  const submittedColumnIds = formData
    .getAll("columnFieldDefinitionId")
    .map(String)
    .filter(Boolean);
  const columnFieldDefinitionIds = submittedColumnIds.filter((fieldId, index) => {
    if (submittedColumnIds.indexOf(fieldId) !== index) {
      return false;
    }

    const field = activeFieldById.get(fieldId);

    if (!field) {
      const staleField = allFieldById.get(fieldId);
      errors.columnFieldDefinitionId = staleField?.archivedAt
        ? `${staleField.name} is archived. Remove it from columns before saving.`
        : "Columns must reference active fields.";
      return false;
    }

    return true;
  });

  if (columnFieldDefinitionIds.length === 0) {
    errors.columnFieldDefinitionId = "Choose at least one visible column.";
  }

  const values: ViewFormValues = {
    name,
    filters,
    sorts,
    columnFieldDefinitionIds,
    isDefault: getLastFormString(formData, "isDefault") === "true",
  };

  return {
    success: Object.keys(errors).length === 0,
    message: "",
    errors,
    values,
  };
}
