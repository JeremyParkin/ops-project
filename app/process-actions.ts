"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  archiveProcessTemplate as archiveProcessTemplateInRepository,
  cancelProcessRun as cancelProcessRunInRepository,
  completeProcessStepRun as completeProcessStepRunInRepository,
  decideProcessApproval as decideProcessApprovalInRepository,
  deleteProcessTemplateIfSafe,
  reassignProcessStepRun as reassignProcessStepRunInRepository,
  restoreProcessTemplate as restoreProcessTemplateInRepository,
  retryProcessActionStep as retryProcessActionStepInRepository,
  saveProcessTemplate as saveProcessTemplateInRepository,
  startProcessRun as startProcessRunInRepository,
} from "@/lib/domain/process-repository";
import {
  createProcessStepRunCommentWithMentions as createProcessStepRunCommentWithMentionsInRepository,
  tombstoneProcessStepRunComment as tombstoneProcessStepRunCommentInRepository,
} from "@/lib/domain/process-step-run-comment-repository";
import {
  cancelProcessStepRunInputRequest as cancelProcessStepRunInputRequestInRepository,
  createProcessStepRunInputRequest as createProcessStepRunInputRequestInRepository,
  respondProcessStepRunInputRequest as respondProcessStepRunInputRequestInRepository,
} from "@/lib/domain/process-step-run-input-request-repository";
import {
  type ProcessTemplateFormState,
  validateProcessTemplateFormData,
} from "@/lib/domain/process-validation";
import type { ProcessConditionWaitRule, ProcessWaitRule } from "@/lib/domain/process-types";
import { RECORD_COMMENT_BODY_MAX_LENGTH } from "@/lib/domain/record-comment-validation";
import {
  createRecurrenceRule,
  setRecurrenceRuleActive,
  updateRecurrenceRule,
} from "@/lib/domain/recurrence-repository";
import { validateRecurrenceRuleInput } from "@/lib/domain/recurrence-validation";
import type { ProcessRecurrenceRuleInput } from "@/lib/domain/recurrence-types";

export type ProcessActionState = {
  success: boolean;
  message: string;
};

export type ProcessStepRunCommentActionState = {
  success: boolean;
  message: string;
  body?: string;
  resetKey?: string;
};

const initialProcessStepRunCommentActionState: ProcessStepRunCommentActionState = {
  success: false,
  message: "",
  body: "",
};

type ProcessTemplateContext = {
  workspaceId: string;
  processTemplateId?: string;
};

type ProcessTemplateLifecycleContext = {
  workspaceId: string;
  processTemplateId: string;
};

type StartProcessRunContext = {
  workspaceId: string;
  processTemplateId: string;
  originEntityTypeId: string;
  originRecordId: string;
};

type RecurrenceRuleContext = {
  workspaceId: string;
  processTemplateId: string;
  originEntityTypeId: string;
  originRecordId: string;
};

type RecurrenceRuleLifecycleContext = {
  workspaceId: string;
  recurrenceRuleId: string;
  originEntityTypeId: string;
  originRecordId: string;
};

type CompleteProcessStepRunContext = {
  workspaceId: string;
  processRunId: string;
};

type CancelProcessRunContext = {
  workspaceId: string;
  processRunId: string;
};

type ReassignProcessStepRunContext = {
  workspaceId: string;
  processRunId: string;
};

type DecideProcessApprovalContext = CompleteProcessStepRunContext;

type ProcessStepRunCommentContext = CompleteProcessStepRunContext & {
  processStepRunId?: string;
  commentId?: string;
};

type ProcessStepRunInputRequestContext = CompleteProcessStepRunContext & {
  processStepRunId?: string;
  requestId?: string;
};

function getWaitRule(step: ProcessTemplateFormState["values"]["steps"][number]): ProcessWaitRule | undefined {
  if (step.nodeType !== "wait") return undefined;
  const timeZone = step.waitTimeZone?.trim();

  if (step.waitKind === "duration") {
    const unit = step.waitUnit === "calendar_days" ? "calendar_days" : "hours";

    // Elapsed-hour waits must not carry a timezone (the RPC rejects one).
    // The form's local state always keeps a timezone value even while the
    // "IANA timezone" field is hidden for hours mode, so this can't rely on
    // `timeZone` being empty — it must check the unit directly.
    return {
      kind: "duration",
      amount: Number(step.waitAmount),
      unit,
      ...(unit === "calendar_days" && timeZone ? { timeZone } : {}),
    };
  }
  if (step.waitKind === "weekdays") {
    return { kind: "weekdays", amount: Number(step.waitAmount), timeZone: timeZone ?? "" };
  }
  if (step.waitTarget === "nth_weekday_next_month") {
    return { kind: "calendar_target", target: "nth_weekday_next_month", ordinal: Number(step.waitOrdinal), time: step.waitTime ?? "", timeZone: timeZone ?? "" };
  }
  if (step.waitTarget === "first_day_of_week_next_month") {
    return { kind: "calendar_target", target: "first_day_of_week_next_month", weekday: Number(step.waitWeekday), time: step.waitTime ?? "", timeZone: timeZone ?? "" };
  }
  return { kind: "calendar_target", target: "specific_datetime", date: step.waitDate ?? "", time: step.waitTime ?? "", timeZone: timeZone ?? "" };
}

function getConditionWaitRule(
  step: ProcessTemplateFormState["values"]["steps"][number],
): ProcessConditionWaitRule | undefined {
  if (step.nodeType !== "condition_wait") return undefined;

  return {
    target:
      step.conditionWaitTargetKind === "related"
        ? {
            kind: "related",
            relationFieldDefinitionId: step.conditionWaitRelationFieldDefinitionId ?? "",
            targetEntityTypeId: step.conditionWaitTargetEntityTypeId ?? "",
          }
        : { kind: "origin" },
    conditions: step.conditionWaitConditions ?? [],
  };
}

function extractRpcErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) {
    const colonIndex = error.message.indexOf(": ");

    return colonIndex >= 0 ? error.message.slice(colonIndex + 2) : error.message;
  }

  return fallback;
}

export async function saveProcessTemplateAction(
  context: ProcessTemplateContext,
  _previousState: ProcessTemplateFormState,
  formData: FormData,
): Promise<ProcessTemplateFormState> {
  const validation = validateProcessTemplateFormData(formData);

  if (!validation.success) {
    return {
      success: false,
      message: "Please fix the highlighted fields.",
      errors: validation.errors,
      values: validation.submittedValues,
    };
  }

  try {
    await saveProcessTemplateInRepository({
      workspaceId: context.workspaceId,
      processTemplateId: context.processTemplateId,
      name: validation.name,
      description: validation.description,
      appliesToEntityTypeId: validation.appliesToEntityTypeId,
      steps: validation.steps.map((step) => ({
        clientKey: step.clientKey,
        nodeId: step.nodeId || null,
        nodeType: step.nodeType ?? "human_task",
        parallelGroupId: step.parallelGroupId || undefined,
        name: step.name,
        assigneeUserId: step.assigneeUserId || null,
        dueRule: step.dueAmount
          ? { amount: Number(step.dueAmount), unit: step.dueUnit }
          : undefined,
        waitRule: getWaitRule(step),
        conditionWaitRule: getConditionWaitRule(step),
        actionConfig: step.nodeType === "action" ? step.actionConfig : undefined,
        routes: step.routes,
      })),
    });
  } catch (error) {
    return {
      success: false,
      message: extractRpcErrorMessage(
        error,
        "Unable to save the process template. Please try again.",
      ),
      errors: { _form: "The process template could not be saved." },
      values: validation.submittedValues,
    };
  }

  revalidatePath("/processes");
  redirect("/processes");
}

export async function archiveProcessTemplateAction(
  context: ProcessTemplateLifecycleContext,
  previousState: ProcessActionState,
  formData: FormData,
): Promise<ProcessActionState> {
  void previousState;
  void formData;

  try {
    await archiveProcessTemplateInRepository(context);
  } catch (error) {
    return {
      success: false,
      message: extractRpcErrorMessage(error, "Unable to archive the process template."),
    };
  }

  revalidatePath("/processes");

  return { success: true, message: "Process template archived." };
}

export async function restoreProcessTemplateAction(
  context: ProcessTemplateLifecycleContext,
  previousState: ProcessActionState,
  formData: FormData,
): Promise<ProcessActionState> {
  void previousState;
  void formData;

  try {
    await restoreProcessTemplateInRepository(context);
  } catch (error) {
    return {
      success: false,
      message: extractRpcErrorMessage(error, "Unable to restore the process template."),
    };
  }

  revalidatePath("/processes");

  return { success: true, message: "Process template restored." };
}

export async function deleteProcessTemplateAction(
  context: ProcessTemplateLifecycleContext,
  previousState: ProcessActionState,
  formData: FormData,
): Promise<ProcessActionState> {
  void previousState;
  void formData;

  try {
    const result = await deleteProcessTemplateIfSafe(context);

    if (!result.deleted) {
      const dependencies = [
        result.runCount > 0
          ? `${result.runCount} process run${result.runCount === 1 ? "" : "s"}`
          : null,
        result.workflowCount > 0
          ? `${result.workflowCount} workflow${result.workflowCount === 1 ? "" : "s"}`
          : null,
      ].filter((dependency): dependency is string => Boolean(dependency));

      return {
        success: false,
        message: `Cannot delete this process template because ${dependencies.join(
          " and ",
        )} reference it.`,
      };
    }
  } catch (error) {
    return {
      success: false,
      message: extractRpcErrorMessage(error, "Unable to delete the process template."),
    };
  }

  revalidatePath("/processes");

  return { success: true, message: "Process template deleted." };
}

export async function startProcessRunAction(
  context: StartProcessRunContext,
  previousState: ProcessActionState,
  formData: FormData,
): Promise<ProcessActionState> {
  void previousState;
  void formData;

  let runId: string;

  try {
    runId = await startProcessRunInRepository(context);
  } catch (error) {
    return {
      success: false,
      message: extractRpcErrorMessage(error, "Unable to start the process."),
    };
  }

  revalidatePath(
    `/entities/${context.originEntityTypeId}/records/${context.originRecordId}`,
  );
  redirect(`/process-runs/${runId}`);
}

export async function completeProcessStepRunAction(
  context: CompleteProcessStepRunContext,
  _previousState: ProcessActionState,
  formData: FormData,
): Promise<ProcessActionState> {
  const stepRunId = formData.get("stepRunId");

  if (typeof stepRunId !== "string" || !stepRunId) {
    return { success: false, message: "Invalid step." };
  }

  try {
    await completeProcessStepRunInRepository({
      workspaceId: context.workspaceId,
      processRunId: context.processRunId,
      stepRunId,
    });
  } catch (error) {
    return {
      success: false,
      message: extractRpcErrorMessage(error, "Unable to complete this step."),
    };
  }

  revalidatePath(`/process-runs/${context.processRunId}`);

  return { success: true, message: "Step completed." };
}

export async function cancelProcessRunAction(
  context: CancelProcessRunContext,
  _previousState: ProcessActionState,
  formData: FormData,
): Promise<ProcessActionState> {
  const reason = formData.get("reason");

  if (typeof reason !== "string" || !reason.trim()) {
    return { success: false, message: "Cancellation requires a reason." };
  }

  try {
    await cancelProcessRunInRepository({
      workspaceId: context.workspaceId,
      processRunId: context.processRunId,
      reason,
    });
  } catch (error) {
    return {
      success: false,
      message: extractRpcErrorMessage(error, "Unable to cancel this process run."),
    };
  }

  revalidatePath(`/process-runs/${context.processRunId}`);

  return { success: true, message: "Process run cancelled." };
}

export async function reassignProcessStepRunAction(
  context: ReassignProcessStepRunContext,
  _previousState: ProcessActionState,
  formData: FormData,
): Promise<ProcessActionState> {
  const stepRunId = formData.get("stepRunId");
  const newAssigneeUserId = formData.get("newAssigneeUserId");
  const reason = formData.get("reason");

  if (typeof stepRunId !== "string" || !stepRunId) {
    return { success: false, message: "Invalid step." };
  }
  if (typeof newAssigneeUserId !== "string" || !newAssigneeUserId) {
    return { success: false, message: "Choose who to reassign this to." };
  }

  try {
    await reassignProcessStepRunInRepository({
      workspaceId: context.workspaceId,
      processRunId: context.processRunId,
      stepRunId,
      newAssigneeUserId,
      reason: typeof reason === "string" && reason.trim() ? reason : undefined,
    });
  } catch (error) {
    return {
      success: false,
      message: extractRpcErrorMessage(error, "Unable to reassign this step."),
    };
  }

  revalidatePath(`/process-runs/${context.processRunId}`);

  return { success: true, message: "Step reassigned." };
}

export async function retryProcessActionStepAction(
  context: CompleteProcessStepRunContext,
  _previousState: ProcessActionState,
  formData: FormData,
): Promise<ProcessActionState> {
  const stepRunId = formData.get("stepRunId");

  if (typeof stepRunId !== "string" || !stepRunId) {
    return { success: false, message: "Invalid step." };
  }

  try {
    await retryProcessActionStepInRepository({
      workspaceId: context.workspaceId,
      processRunId: context.processRunId,
      stepRunId,
    });
  } catch (error) {
    return {
      success: false,
      message: extractRpcErrorMessage(error, "Unable to retry this action."),
    };
  }

  revalidatePath(`/process-runs/${context.processRunId}`);

  return { success: true, message: "Action retried." };
}

export async function decideProcessApprovalAction(
  context: DecideProcessApprovalContext,
  _previousState: ProcessActionState,
  formData: FormData,
): Promise<ProcessActionState> {
  const stepRunId = formData.get("stepRunId");
  const outcomeId = formData.get("outcomeId");

  if (
    typeof stepRunId !== "string" ||
    !stepRunId ||
    typeof outcomeId !== "string" ||
    !outcomeId
  ) {
    return { success: false, message: "Invalid approval decision." };
  }

  try {
    await decideProcessApprovalInRepository({
      workspaceId: context.workspaceId,
      processRunId: context.processRunId,
      stepRunId,
      outcomeId,
    });
  } catch (error) {
    return {
      success: false,
      message: extractRpcErrorMessage(error, "Unable to submit this approval decision."),
    };
  }

  revalidatePath(`/process-runs/${context.processRunId}`);

  return { success: true, message: "Approval decision recorded." };
}

export async function createProcessStepRunCommentAction(
  context: ProcessStepRunCommentContext,
  _previousState: ProcessStepRunCommentActionState,
  formData: FormData,
): Promise<ProcessStepRunCommentActionState> {
  const processStepRunId = context.processStepRunId ?? String(formData.get("processStepRunId") ?? "");
  const body = String(formData.get("body") ?? "").trim();

  if (!processStepRunId) {
    return {
      ...initialProcessStepRunCommentActionState,
      message: "Invalid step.",
    };
  }

  if (!body) {
    return {
      ...initialProcessStepRunCommentActionState,
      message: "Comment body is required.",
    };
  }

  if (body.length > RECORD_COMMENT_BODY_MAX_LENGTH) {
    return {
      success: false,
      message: `Comment body must be ${RECORD_COMMENT_BODY_MAX_LENGTH} characters or fewer.`,
      body,
    };
  }

  let commentId: string;

  try {
    const mentionedUserIds = formData
      .getAll("mentionedUserIds")
      .map((value) => String(value))
      .filter((value) => value.length > 0);

    commentId = await createProcessStepRunCommentWithMentionsInRepository({
      workspaceId: context.workspaceId,
      processRunId: context.processRunId,
      processStepRunId,
      body,
      mentionedUserIds,
    });
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : "Unable to add comment. Please try again.",
      body,
    };
  }

  revalidatePath(`/process-runs/${context.processRunId}`);

  return {
    success: true,
    message: "Comment added.",
    body: "",
    resetKey: commentId,
  };
}

export async function tombstoneProcessStepRunCommentAction(
  context: ProcessStepRunCommentContext,
  _previousState: ProcessStepRunCommentActionState,
  formData: FormData,
): Promise<ProcessStepRunCommentActionState> {
  const commentId = context.commentId ?? String(formData.get("commentId") ?? "");

  if (!commentId) {
    return {
      success: false,
      message: "Unable to remove comment. Please try again.",
    };
  }

  try {
    await tombstoneProcessStepRunCommentInRepository({
      workspaceId: context.workspaceId,
      commentId,
    });
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : "Unable to remove comment. Please try again.",
    };
  }

  revalidatePath(`/process-runs/${context.processRunId}`);

  return {
    success: true,
    message: "Comment removed.",
  };
}

export async function createProcessStepRunInputRequestAction(
  context: ProcessStepRunInputRequestContext,
  _previousState: ProcessStepRunCommentActionState,
  formData: FormData,
): Promise<ProcessStepRunCommentActionState> {
  const processStepRunId = context.processStepRunId ?? String(formData.get("processStepRunId") ?? "");
  const body = String(formData.get("body") ?? "").trim();
  const recipientUserId = String(formData.get("recipientUserId") ?? "");

  if (!processStepRunId) {
    return {
      ...initialProcessStepRunCommentActionState,
      message: "Invalid step.",
    };
  }

  if (!recipientUserId) {
    return {
      ...initialProcessStepRunCommentActionState,
      message: "Choose who should respond.",
      body,
    };
  }

  if (!body) {
    return {
      ...initialProcessStepRunCommentActionState,
      message: "Request body is required.",
    };
  }

  if (body.length > RECORD_COMMENT_BODY_MAX_LENGTH) {
    return {
      success: false,
      message: `Request body must be ${RECORD_COMMENT_BODY_MAX_LENGTH} characters or fewer.`,
      body,
    };
  }

  let requestId: string;

  try {
    requestId = await createProcessStepRunInputRequestInRepository({
      workspaceId: context.workspaceId,
      processRunId: context.processRunId,
      processStepRunId,
      recipientUserId,
      body,
    });
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : "Unable to request input. Please try again.",
      body,
    };
  }

  revalidatePath(`/process-runs/${context.processRunId}`);

  return {
    success: true,
    message: "Input requested.",
    body: "",
    resetKey: requestId,
  };
}

export async function respondProcessStepRunInputRequestAction(
  context: ProcessStepRunInputRequestContext,
  _previousState: ProcessStepRunCommentActionState,
  formData: FormData,
): Promise<ProcessStepRunCommentActionState> {
  const requestId = context.requestId ?? String(formData.get("requestId") ?? "");
  const body = String(formData.get("body") ?? "").trim();

  if (!requestId) {
    return {
      success: false,
      message: "Unable to respond to request. Please try again.",
      body,
    };
  }

  if (!body) {
    return {
      ...initialProcessStepRunCommentActionState,
      message: "Response body is required.",
    };
  }

  if (body.length > RECORD_COMMENT_BODY_MAX_LENGTH) {
    return {
      success: false,
      message: `Response body must be ${RECORD_COMMENT_BODY_MAX_LENGTH} characters or fewer.`,
      body,
    };
  }

  let commentId: string;

  try {
    commentId = await respondProcessStepRunInputRequestInRepository({
      workspaceId: context.workspaceId,
      requestId,
      body,
    });
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : "Unable to respond to request. Please try again.",
      body,
    };
  }

  revalidatePath(`/process-runs/${context.processRunId}`);

  return {
    success: true,
    message: "Response added.",
    body: "",
    resetKey: commentId,
  };
}

export async function cancelProcessStepRunInputRequestAction(
  context: ProcessStepRunInputRequestContext,
  _previousState: ProcessStepRunCommentActionState,
  formData: FormData,
): Promise<ProcessStepRunCommentActionState> {
  const requestId = context.requestId ?? String(formData.get("requestId") ?? "");

  if (!requestId) {
    return {
      success: false,
      message: "Unable to cancel request. Please try again.",
    };
  }

  try {
    await cancelProcessStepRunInputRequestInRepository({
      workspaceId: context.workspaceId,
      requestId,
    });
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : "Unable to cancel request. Please try again.",
    };
  }

  revalidatePath(`/process-runs/${context.processRunId}`);

  return {
    success: true,
    message: "Input request cancelled.",
  };
}

function parseRecurrenceRuleFormData(formData: FormData): ProcessRecurrenceRuleInput | null {
  const frequency = formData.get("frequency");
  const intervalCountRaw = formData.get("intervalCount");
  const dayOfWeekRaw = formData.get("dayOfWeek");
  const dayOfMonthRaw = formData.get("dayOfMonth");
  const startDate = formData.get("startDate");
  const endDateRaw = formData.get("endDate");
  const timeOfDay = formData.get("timeOfDay");

  if (
    typeof frequency !== "string" ||
    (frequency !== "daily" && frequency !== "weekly" && frequency !== "monthly") ||
    typeof intervalCountRaw !== "string" ||
    typeof startDate !== "string" ||
    typeof timeOfDay !== "string"
  ) {
    return null;
  }

  const intervalCount = Number(intervalCountRaw);
  const dayOfWeek =
    typeof dayOfWeekRaw === "string" && dayOfWeekRaw !== "" ? Number(dayOfWeekRaw) : undefined;
  const dayOfMonth =
    typeof dayOfMonthRaw === "string" && dayOfMonthRaw !== "" ? Number(dayOfMonthRaw) : undefined;
  const endDate = typeof endDateRaw === "string" && endDateRaw !== "" ? endDateRaw : undefined;

  return { frequency, intervalCount, dayOfWeek, dayOfMonth, startDate, endDate, timeOfDay };
}

export async function createRecurrenceRuleAction(
  context: RecurrenceRuleContext,
  _previousState: ProcessActionState,
  formData: FormData,
): Promise<ProcessActionState> {
  const input = parseRecurrenceRuleFormData(formData);

  if (!input) {
    return { success: false, message: "Invalid recurrence schedule." };
  }

  const validationErrors = validateRecurrenceRuleInput(input);

  if (validationErrors.length > 0) {
    return { success: false, message: validationErrors[0] };
  }

  try {
    await createRecurrenceRule({
      workspaceId: context.workspaceId,
      processTemplateId: context.processTemplateId,
      originEntityTypeId: context.originEntityTypeId,
      originRecordId: context.originRecordId,
      input,
    });
  } catch (error) {
    return {
      success: false,
      message: extractRpcErrorMessage(error, "Unable to set up this recurring schedule."),
    };
  }

  revalidatePath(`/entities/${context.originEntityTypeId}/records/${context.originRecordId}`);

  return { success: true, message: "Recurring schedule created." };
}

export async function updateRecurrenceRuleAction(
  context: RecurrenceRuleLifecycleContext,
  _previousState: ProcessActionState,
  formData: FormData,
): Promise<ProcessActionState> {
  const input = parseRecurrenceRuleFormData(formData);

  if (!input) {
    return { success: false, message: "Invalid recurrence schedule." };
  }

  const validationErrors = validateRecurrenceRuleInput(input);

  if (validationErrors.length > 0) {
    return { success: false, message: validationErrors[0] };
  }

  try {
    await updateRecurrenceRule({
      workspaceId: context.workspaceId,
      recurrenceRuleId: context.recurrenceRuleId,
      input,
    });
  } catch (error) {
    return {
      success: false,
      message: extractRpcErrorMessage(error, "Unable to update this recurring schedule."),
    };
  }

  revalidatePath(`/entities/${context.originEntityTypeId}/records/${context.originRecordId}`);

  return { success: true, message: "Recurring schedule updated." };
}

export async function setRecurrenceRuleActiveAction(
  context: RecurrenceRuleLifecycleContext,
  _previousState: ProcessActionState,
  formData: FormData,
): Promise<ProcessActionState> {
  const active = formData.get("active") === "true";

  try {
    await setRecurrenceRuleActive({
      workspaceId: context.workspaceId,
      recurrenceRuleId: context.recurrenceRuleId,
      active,
    });
  } catch (error) {
    return {
      success: false,
      message: extractRpcErrorMessage(error, "Unable to update this recurring schedule."),
    };
  }

  revalidatePath(`/entities/${context.originEntityTypeId}/records/${context.originRecordId}`);

  return {
    success: true,
    message: active ? "Recurring schedule enabled." : "Recurring schedule disabled.",
  };
}
