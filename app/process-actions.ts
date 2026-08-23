"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  archiveProcessTemplate as archiveProcessTemplateInRepository,
  completeProcessStepRun as completeProcessStepRunInRepository,
  deleteProcessTemplateIfSafe,
  restoreProcessTemplate as restoreProcessTemplateInRepository,
  saveProcessTemplate as saveProcessTemplateInRepository,
  startProcessRun as startProcessRunInRepository,
} from "@/lib/domain/process-repository";
import {
  type ProcessTemplateFormState,
  validateProcessTemplateFormData,
} from "@/lib/domain/process-validation";

export type ProcessActionState = {
  success: boolean;
  message: string;
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

type CompleteProcessStepRunContext = {
  workspaceId: string;
  processRunId: string;
};

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
        nodeId: step.nodeId || null,
        name: step.name,
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
      return {
        success: false,
        message: `Cannot delete this process template because ${result.runCount} process run${
          result.runCount === 1 ? "" : "s"
        } reference it.`,
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
