import type { ProcessBranchCondition, ProcessNodeType } from "./process-types";

export type ProcessTemplateRouteFormValue = {
  id: string;
  targetStepKey: string;
  isDefault: boolean;
  isParallel?: boolean;
  conditions: ProcessBranchCondition[];
};

export type ProcessTemplateStepFormValue = {
  clientKey: string;
  nodeId: string;
  nodeType?: ProcessNodeType;
  parallelGroupId?: string;
  name: string;
  assigneeUserId: string;
  dueAmount: string;
  dueUnit: string;
  routes: ProcessTemplateRouteFormValue[];
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

function emptyStep(clientKey: string): ProcessTemplateStepFormValue {
  return {
    clientKey,
    nodeId: "",
    nodeType: "human_task",
    parallelGroupId: "",
    name: "",
    assigneeUserId: "",
    dueAmount: "",
    dueUnit: "days",
    routes: [],
  };
}

export const initialProcessTemplateFormState: ProcessTemplateFormState = {
  success: false,
  message: "",
  errors: {},
  values: {
    name: "",
    description: "",
    appliesToEntityTypeId: "",
    steps: [emptyStep("step-1"), emptyStep("step-2")],
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

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function parseCondition(value: unknown): ProcessBranchCondition | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const rawValue = record.value;

  if (
    typeof record.sourceFieldDefinitionId !== "string" ||
    typeof record.operator !== "string" ||
    (rawValue !== undefined &&
      rawValue !== null &&
      typeof rawValue !== "string" &&
      typeof rawValue !== "number" &&
      typeof rawValue !== "boolean")
  ) {
    return null;
  }

  return {
    sourceFieldDefinitionId: record.sourceFieldDefinitionId,
    operator: record.operator as ProcessBranchCondition["operator"],
    ...(rawValue === undefined ? {} : { value: rawValue }),
  };
}

function parseStepsFromJson(value: string): ProcessTemplateStepFormValue[] | null {
  try {
    const parsed = JSON.parse(value);

    if (!Array.isArray(parsed)) {
      return null;
    }

    return parsed.map((step, index) => {
      if (typeof step !== "object" || step === null || Array.isArray(step)) {
        throw new Error("Invalid step");
      }

      const record = step as Record<string, unknown>;
      const routes = Array.isArray(record.routes)
        ? record.routes.map((route, routeIndex) => {
            if (typeof route !== "object" || route === null || Array.isArray(route)) {
              throw new Error("Invalid route");
            }

            const routeRecord = route as Record<string, unknown>;
            const conditions = Array.isArray(routeRecord.conditions)
              ? routeRecord.conditions.map(parseCondition)
              : [];

            if (conditions.some((condition) => condition === null)) {
              throw new Error("Invalid condition");
            }

            return {
              id: asString(routeRecord.id) || `route-${index}-${routeIndex}`,
              targetStepKey: asString(routeRecord.targetStepKey),
              isDefault: routeRecord.isDefault === true,
              isParallel: routeRecord.isParallel === true,
              conditions: conditions as ProcessBranchCondition[],
            };
          })
        : [];

      return {
        clientKey: asString(record.clientKey) || `step-${index + 1}`,
        nodeId: asString(record.nodeId),
        nodeType:
          record.nodeType === "parallel_split" || record.nodeType === "parallel_join"
            ? record.nodeType
            : "human_task",
        parallelGroupId: asString(record.parallelGroupId),
        name: asString(record.name).trim(),
        assigneeUserId: asString(record.assigneeUserId).trim(),
        dueAmount: asString(record.dueAmount).trim(),
        dueUnit: asString(record.dueUnit) || "days",
        routes,
      };
    });
  } catch {
    return null;
  }
}

function parseSubmittedSteps(formData: FormData) {
  const serializedSteps = formData.get("processSteps");

  if (typeof serializedSteps === "string") {
    return parseStepsFromJson(serializedSteps);
  }

  const nodeIds = formData.getAll("stepNodeId").map((value) => String(value));
  const stepNames = formData.getAll("stepName").map((value) => String(value).trim());
  const stepAssigneeUserIds = formData
    .getAll("stepAssigneeUserId")
    .map((value) => String(value).trim());
  const stepDueAmounts = formData.getAll("stepDueAmount").map((value) => String(value).trim());
  const stepDueUnits = formData.getAll("stepDueUnit").map((value) => String(value));

  if (nodeIds.length !== stepNames.length) {
    return null;
  }

  return nodeIds.map((nodeId, index) => ({
    clientKey: nodeId || `step-${index + 1}`,
    nodeId,
    nodeType: "human_task" as const,
    parallelGroupId: "",
    name: stepNames[index] ?? "",
    assigneeUserId: stepAssigneeUserIds[index] ?? "",
    dueAmount: stepDueAmounts[index] ?? "",
    dueUnit: stepDueUnits[index] ?? "days",
    routes: [],
  }));
}

export function validateProcessTemplateFormData(
  formData: FormData,
): ProcessTemplateValidationResult {
  const errors: Record<string, string> = {};
  const name = getString(formData, "name");
  const description = getString(formData, "description");
  const appliesToEntityTypeId = getString(formData, "appliesToEntityTypeId");
  const submittedSteps = parseSubmittedSteps(formData);
  const safeSteps = submittedSteps ?? [];
  const submittedValues: ProcessTemplateFormValues = {
    name,
    description,
    appliesToEntityTypeId,
    steps: safeSteps,
  };

  if (!name) {
    errors.name = "Name is required.";
  }

  if (!appliesToEntityTypeId) {
    errors.appliesToEntityTypeId = "Applies-to entity type is required.";
  }

  if (!submittedSteps || submittedSteps.length === 0) {
    errors._form = "At least one valid step is required.";
  } else if (submittedSteps.some((step) => (step.nodeType ?? "human_task") === "human_task" && !step.name)) {
    errors._form = "Every step requires a name.";
  }

  const clientKeys = new Set<string>();

  safeSteps.forEach((step, index) => {
    if (!step.clientKey || clientKeys.has(step.clientKey)) {
      errors._form = "Every step must have a unique stable identity.";
    }
    clientKeys.add(step.clientKey);

    const nodeType = step.nodeType ?? "human_task";

    if (
      nodeType !== "human_task" &&
      nodeType !== "parallel_split" &&
      nodeType !== "parallel_join"
    ) {
      errors._form = "Every process node must have a supported type.";
    }

    if (nodeType !== "human_task" && !step.parallelGroupId) {
      errors._form = "Parallel system nodes require a matching parallel group.";
    }

    if (nodeType !== "human_task" && (step.assigneeUserId || step.dueAmount)) {
      errors[`stepRoutes.${index}`] = "Parallel system nodes cannot have an assignee or due rule.";
    }

    if (nodeType === "human_task" && step.dueAmount) {
      if (step.dueUnit !== "hours" && step.dueUnit !== "days") {
        errors[`stepDueAmount.${index}`] = "Due unit must be hours or days.";
      } else if (!/^[1-9]\d*$/.test(step.dueAmount)) {
        errors[`stepDueAmount.${index}`] = "Due offset must be a whole number.";
      } else {
        const amount = Number(step.dueAmount);

        if (!Number.isSafeInteger(amount) || amount > PROCESS_DUE_RULE_MAX_AMOUNT) {
          errors[`stepDueAmount.${index}`] = `Due offset must be between 1 and ${PROCESS_DUE_RULE_MAX_AMOUNT}.`;
        }
      }
    }

    const defaultRoutes = step.routes.filter((route) => route.isDefault);

    if (defaultRoutes.length > 1) {
      errors[`stepRoutes.${index}`] = "A step can have only one default route.";
    }

    step.routes.forEach((route) => {
      if (!route.targetStepKey) {
        errors[`stepRoutes.${index}`] = "Every route needs a target step.";
      }
      if (route.isParallel && (route.isDefault || route.conditions.length > 0)) {
        errors[`stepRoutes.${index}`] = "Parallel branch routes cannot have conditions or be default routes.";
      }
      if (route.isDefault && route.conditions.length > 0) {
        errors[`stepRoutes.${index}`] = "The default route cannot have conditions.";
      }
      if (!route.isParallel && !route.isDefault && route.conditions.length === 0) {
        errors[`stepRoutes.${index}`] = "A conditional route needs at least one condition.";
      }
    });

    if (nodeType !== "parallel_split" && step.routes.length > 1 && defaultRoutes.length !== 1) {
      errors[`stepRoutes.${index}`] = "Conditional routing requires one Otherwise route.";
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
    steps: safeSteps as ValidatedProcessTemplateStep[],
    submittedValues,
  };
}
