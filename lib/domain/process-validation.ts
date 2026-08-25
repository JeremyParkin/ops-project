import type { ProcessBranchCondition, ProcessNodeType } from "./process-types";

export type ProcessTemplateRouteFormValue = {
  id: string;
  targetStepKey: string;
  isDefault: boolean;
  isParallel?: boolean;
  approvalOutcomeId?: string;
  approvalOutcomeLabel?: string;
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
  waitKind?: string;
  waitAmount?: string;
  waitUnit?: string;
  waitTarget?: string;
  waitOrdinal?: string;
  waitWeekday?: string;
  waitDate?: string;
  waitTime?: string;
  waitTimeZone?: string;
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
    waitKind: "duration",
    waitAmount: "",
    waitUnit: "hours",
    waitTarget: "nth_weekday_next_month",
    waitOrdinal: "1",
    waitWeekday: "1",
    waitDate: "",
    waitTime: "09:00",
    waitTimeZone: "America/Toronto",
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
              approvalOutcomeId: asString(routeRecord.approvalOutcomeId).trim(),
              approvalOutcomeLabel: asString(routeRecord.approvalOutcomeLabel).trim(),
              conditions: conditions as ProcessBranchCondition[],
            };
          })
        : [];

      return {
        clientKey: asString(record.clientKey) || `step-${index + 1}`,
        nodeId: asString(record.nodeId),
        nodeType:
          record.nodeType === "approval" ||
          record.nodeType === "wait" ||
          record.nodeType === "parallel_split" ||
          record.nodeType === "parallel_join"
            ? record.nodeType
            : "human_task",
        parallelGroupId: asString(record.parallelGroupId),
        name: asString(record.name).trim(),
        assigneeUserId: asString(record.assigneeUserId).trim(),
        dueAmount: asString(record.dueAmount).trim(),
        dueUnit: asString(record.dueUnit) || "days",
        waitKind: asString(record.waitKind) || "duration",
        waitAmount: asString(record.waitAmount).trim(),
        waitUnit: asString(record.waitUnit) || "hours",
        waitTarget: asString(record.waitTarget) || "nth_weekday_next_month",
        waitOrdinal: asString(record.waitOrdinal) || "1",
        waitWeekday: asString(record.waitWeekday) || "1",
        waitDate: asString(record.waitDate),
        waitTime: asString(record.waitTime) || "09:00",
        waitTimeZone: asString(record.waitTimeZone) || "America/Toronto",
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
    waitKind: "duration",
    waitAmount: "",
    waitUnit: "hours",
    waitTarget: "nth_weekday_next_month",
    waitOrdinal: "1",
    waitWeekday: "1",
    waitDate: "",
    waitTime: "09:00",
    waitTimeZone: "America/Toronto",
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
  } else if (
    submittedSteps.some(
      (step) =>
        ((step.nodeType ?? "human_task") === "human_task" ||
          (step.nodeType ?? "human_task") === "approval" ||
          (step.nodeType ?? "human_task") === "wait") &&
        !step.name,
    )
  ) {
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
      nodeType !== "approval" &&
      nodeType !== "wait" &&
      nodeType !== "parallel_split" &&
      nodeType !== "parallel_join"
    ) {
      errors._form = "Every process node must have a supported type.";
    }

    const isSystemNode = nodeType === "parallel_split" || nodeType === "parallel_join";

    if (isSystemNode && !step.parallelGroupId) {
      errors._form = "Parallel system nodes require a matching parallel group.";
    }

    if (isSystemNode && (step.assigneeUserId || step.dueAmount)) {
      errors[`stepRoutes.${index}`] = "Parallel system nodes cannot have an assignee or due rule.";
    }

    if ((nodeType === "human_task" || nodeType === "approval") && step.dueAmount) {
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

    if (nodeType === "wait") {
      if (step.assigneeUserId || step.dueAmount) {
        errors[`stepRoutes.${index}`] = "Wait nodes cannot have an assignee or due rule.";
      }

      const amount = Number(step.waitAmount);
      const hasPositiveAmount = /^[1-9]\\d*$/.test(step.waitAmount ?? "")
        && Number.isSafeInteger(amount)
        && amount <= PROCESS_DUE_RULE_MAX_AMOUNT;
      const requiresTimeZone = step.waitKind !== "duration" || step.waitUnit === "calendar_days";
      const isTime = /^\\d{2}:\\d{2}$/.test(step.waitTime ?? "");
      const isDate = /^\\d{4}-\\d{2}-\\d{2}$/.test(step.waitDate ?? "");

      if (step.waitKind === "duration") {
        if (!hasPositiveAmount || (step.waitUnit !== "hours" && step.waitUnit !== "calendar_days")) {
          errors[`stepRoutes.${index}`] = "Wait duration must be a whole positive number of hours or calendar days.";
        }
      } else if (step.waitKind === "weekdays") {
        if (!hasPositiveAmount) {
          errors[`stepRoutes.${index}`] = "Weekday waits must use a whole positive number.";
        }
      } else if (step.waitKind === "calendar_target") {
        if (!isTime) {
          errors[`stepRoutes.${index}`] = "Calendar waits require a valid time.";
        }
        if (step.waitTarget === "nth_weekday_next_month") {
          const ordinal = Number(step.waitOrdinal);
          if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > 20) {
            errors[`stepRoutes.${index}`] = "Choose the 1st through 20th weekday of next month.";
          }
        } else if (step.waitTarget === "first_day_of_week_next_month") {
          const weekday = Number(step.waitWeekday);
          if (!Number.isSafeInteger(weekday) || weekday < 0 || weekday > 6) {
            errors[`stepRoutes.${index}`] = "Choose a day of the week.";
          }
        } else if (step.waitTarget === "specific_datetime") {
          if (!isDate) {
            errors[`stepRoutes.${index}`] = "Choose a valid calendar date.";
          }
        } else {
          errors[`stepRoutes.${index}`] = "Choose a supported calendar wait target.";
        }
      } else {
        errors[`stepRoutes.${index}`] = "Choose a supported wait mode.";
      }

      if (requiresTimeZone && !(step.waitTimeZone ?? "").trim()) {
        errors[`stepRoutes.${index}`] = "Calendar waits require an IANA timezone.";
      }
    }

    const defaultRoutes = step.routes.filter((route) => route.isDefault);
    const approvalOutcomeIds = new Set<string>();
    const approvalOutcomeLabels = new Set<string>();

    if (defaultRoutes.length > 1) {
      errors[`stepRoutes.${index}`] = "A step can have only one default route.";
    }

    step.routes.forEach((route) => {
      if (!route.targetStepKey) {
        errors[`stepRoutes.${index}`] = "Every route needs a target step.";
      }

      if (nodeType === "approval") {
        const outcomeId = route.approvalOutcomeId?.trim() ?? "";
        const outcomeLabel = route.approvalOutcomeLabel?.trim() ?? "";

        if (!outcomeId || !outcomeLabel) {
          errors[`stepRoutes.${index}`] = "Every approval outcome needs a label and stable identity.";
        }
        if (outcomeId && approvalOutcomeIds.has(outcomeId)) {
          errors[`stepRoutes.${index}`] = "Approval outcome identities must be unique.";
        }
        if (outcomeLabel && approvalOutcomeLabels.has(outcomeLabel.toLocaleLowerCase())) {
          errors[`stepRoutes.${index}`] = "Approval outcome labels must be unique.";
        }
        approvalOutcomeIds.add(outcomeId);
        approvalOutcomeLabels.add(outcomeLabel.toLocaleLowerCase());

        if (route.isDefault || route.isParallel || route.conditions.length > 0) {
          errors[`stepRoutes.${index}`] = "Approval outcomes cannot use conditional, default, or parallel routing.";
        }
        return;
      }

      if (route.approvalOutcomeId || route.approvalOutcomeLabel) {
        errors[`stepRoutes.${index}`] = "Only approval nodes can configure approval outcomes.";
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

    if (nodeType === "approval" && step.routes.length < 2) {
      errors[`stepRoutes.${index}`] = "An approval needs at least two outcomes.";
    }

    if (
      nodeType !== "parallel_split" &&
      nodeType !== "approval" &&
      step.routes.length > 1 &&
      defaultRoutes.length !== 1
    ) {
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
