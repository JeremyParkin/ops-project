export type ProcessTemplateStepFormValue = {
  nodeId: string;
  name: string;
  assigneeUserId: string;
  dueAmount: string;
  dueUnit: string;
};

type ValidatedProcessTemplateStep = Omit<ProcessTemplateStepFormValue, "dueUnit"> & {
  dueUnit: "hours" | "days";
};

export const PROCESS_DUE_RULE_MAX_AMOUNT = 8760;

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
      { nodeId: "", name: "", assigneeUserId: "", dueAmount: "", dueUnit: "days" },
      { nodeId: "", name: "", assigneeUserId: "", dueAmount: "", dueUnit: "days" },
    ],
  },
};

type ProcessTemplateValidationResult =
  | {
      success: true;
      name: string;
      description?: string;
      appliesToEntityTypeId: string;
      steps: ValidatedProcessTemplateStep[];
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
  const stepDueAmounts = formData.getAll("stepDueAmount").map((value) => String(value).trim());
  const stepDueUnits = formData.getAll("stepDueUnit").map((value) => String(value));
  const submittedSteps: ProcessTemplateStepFormValue[] = nodeIds.map((nodeId, index) => ({
    nodeId,
    name: stepNames[index] ?? "",
    assigneeUserId: stepAssigneeUserIds[index] ?? "",
    dueAmount: stepDueAmounts[index] ?? "",
    dueUnit: stepDueUnits[index] ?? "days",
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

  submittedSteps.forEach((step, index) => {
    if (!step.dueAmount) {
      return;
    }

    if (step.dueUnit !== "hours" && step.dueUnit !== "days") {
      errors[`stepDueAmount.${index}`] = "Due unit must be hours or days.";
      return;
    }

    if (!/^[1-9]\d*$/.test(step.dueAmount)) {
      errors[`stepDueAmount.${index}`] = "Due offset must be a whole number.";
      return;
    }

    const amount = Number(step.dueAmount);

    if (!Number.isSafeInteger(amount) || amount > PROCESS_DUE_RULE_MAX_AMOUNT) {
      errors[`stepDueAmount.${index}`] = `Due offset must be between 1 and ${PROCESS_DUE_RULE_MAX_AMOUNT}.`;
    }
  });

  if (Object.keys(errors).length > 0) {
    return { success: false, errors, submittedValues };
  }

  return {
    success: true,
    name,
    description: description || undefined,
    appliesToEntityTypeId,
    steps: submittedSteps as ValidatedProcessTemplateStep[],
    submittedValues,
  };
}
