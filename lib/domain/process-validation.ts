export type ProcessTemplateStepFormValue = {
  nodeId: string;
  name: string;
  assigneeUserId: string;
};

export type ProcessTemplateFormValues = {
  name: string;
  description: string;
  appliesToEntityTypeId: string;
  steps: ProcessTemplateStepFormValue[];
};

export type ProcessTemplateFormState = {
  success: boolean;
  message: string;
  errors: Record<string, string>;
  values: ProcessTemplateFormValues;
};

export const initialProcessTemplateFormState: ProcessTemplateFormState = {
  success: false,
  message: "",
  errors: {},
  values: {
    name: "",
    description: "",
    appliesToEntityTypeId: "",
    steps: [
      { nodeId: "", name: "", assigneeUserId: "" },
      { nodeId: "", name: "", assigneeUserId: "" },
    ],
  },
};

type ProcessTemplateValidationResult =
  | {
      success: true;
      name: string;
      description?: string;
      appliesToEntityTypeId: string;
      steps: ProcessTemplateStepFormValue[];
      submittedValues: ProcessTemplateFormValues;
    }
  | {
      success: false;
      errors: Record<string, string>;
      submittedValues: ProcessTemplateFormValues;
    };

function getString(formData: FormData, key: string) {
  const value = formData.get(key);

  return typeof value === "string" ? value.trim() : "";
}

export function validateProcessTemplateFormData(
  formData: FormData,
): ProcessTemplateValidationResult {
  const errors: Record<string, string> = {};
  const name = getString(formData, "name");
  const description = getString(formData, "description");
  const appliesToEntityTypeId = getString(formData, "appliesToEntityTypeId");
  const nodeIds = formData.getAll("stepNodeId").map((value) => String(value));
  const stepNames = formData.getAll("stepName").map((value) => String(value).trim());
  const stepAssigneeUserIds = formData
    .getAll("stepAssigneeUserId")
    .map((value) => String(value).trim());
  const submittedSteps = nodeIds.map((nodeId, index) => ({
    nodeId,
    name: stepNames[index] ?? "",
    assigneeUserId: stepAssigneeUserIds[index] ?? "",
  }));
  const submittedValues: ProcessTemplateFormValues = {
    name,
    description,
    appliesToEntityTypeId,
    steps: submittedSteps,
  };

  if (!name) {
    errors.name = "Name is required.";
  }

  if (!appliesToEntityTypeId) {
    errors.appliesToEntityTypeId = "Applies-to entity type is required.";
  }

  if (nodeIds.length !== stepNames.length || stepNames.length === 0) {
    errors._form = "At least one step is required.";
  } else if (stepNames.some((stepName) => stepName === "")) {
    errors._form = "Every step requires a name.";
  }

  if (Object.keys(errors).length > 0) {
    return { success: false, errors, submittedValues };
  }

  return {
    success: true,
    name,
    description: description || undefined,
    appliesToEntityTypeId,
    steps: submittedSteps,
    submittedValues,
  };
}
