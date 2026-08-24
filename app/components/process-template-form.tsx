"use client";

import Link from "next/link";
import { useActionState, useMemo, useState } from "react";
import {
  getProcessConditionDefaultOperator,
  getProcessConditionOperatorsForFieldType,
  processConditionOperatorLabels,
  processConditionOperatorNeedsValue,
} from "@/lib/domain/process-conditions";
import type {
  ProcessBranchCondition,
  ProcessBranchConditionOperator,
  ProcessNodeType,
} from "@/lib/domain/process-types";
import type {
  ProcessTemplateFormState,
  ProcessTemplateRouteFormValue,
} from "@/lib/domain/process-validation";
import type { EntityType, FieldDefinition } from "@/lib/domain/types";
import type { RelationRecordOption } from "@/lib/domain/record-repository";
import type { WorkspaceMemberIdentity } from "@/lib/domain/process-types";

export type ProcessTemplateEntityContext = {
  entityType: EntityType;
  fields: FieldDefinition[];
  relationOptionsByFieldId: Record<string, RelationRecordOption[]>;
};

type LocalCondition = {
  id: string;
  sourceFieldDefinitionId: string;
  operator: ProcessBranchConditionOperator;
  value: string;
};

type LocalRoute = {
  id: string;
  targetStepKey: string;
  isDefault: boolean;
  isParallel: boolean;
  approvalOutcomeId?: string;
  approvalOutcomeLabel?: string;
  conditions: LocalCondition[];
};

type LocalStep = {
  key: string;
  nodeId: string;
  nodeType: ProcessNodeType;
  parallelGroupId: string;
  name: string;
  assigneeUserId: string;
  dueAmount: string;
  dueUnit: "hours" | "days";
  routes: LocalRoute[];
};

type ProcessTemplateFormProps = {
  entityContexts: ProcessTemplateEntityContext[];
  members: WorkspaceMemberIdentity[];
  saveProcessTemplateAction: (
    state: ProcessTemplateFormState,
    formData: FormData,
  ) => Promise<ProcessTemplateFormState>;
  initialState: ProcessTemplateFormState;
  isEditing: boolean;
};

function createKey(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createParallelGroupId() {
  return crypto.randomUUID();
}

function FieldError({ message }: { message?: string }) {
  return message ? (
    <p className="mt-1 text-sm text-red-700" role="alert">
      {message}
    </p>
  ) : null;
}

function toLocalCondition(condition: ProcessBranchCondition, index: number): LocalCondition {
  return {
    id: `condition-${index}-${condition.sourceFieldDefinitionId}`,
    sourceFieldDefinitionId: condition.sourceFieldDefinitionId,
    operator: condition.operator,
    value:
      condition.value === null || condition.value === undefined ? "" : String(condition.value),
  };
}

function toLocalRoute(route: ProcessTemplateRouteFormValue, index: number): LocalRoute {
  return {
    id: route.id || `route-${index}`,
    targetStepKey: route.targetStepKey,
    isDefault: route.isDefault,
    isParallel: route.isParallel === true,
    approvalOutcomeId: route.approvalOutcomeId ?? "",
    approvalOutcomeLabel: route.approvalOutcomeLabel ?? "",
    conditions: route.conditions.map(toLocalCondition),
  };
}

function ConditionValueInput({
  field,
  value,
  options,
  onChange,
}: {
  field: FieldDefinition;
  value: string;
  options: RelationRecordOption[];
  onChange: (value: string) => void;
}) {
  if (field.type === "boolean") {
    return (
      <select
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        className="mt-1 block h-9 w-full border border-grit bg-white px-2 text-sm text-graphite outline-none focus:border-brass-deep"
      >
        <option value="">Choose value</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    );
  }

  if (field.type === "relation") {
    return (
      <select
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        className="mt-1 block h-9 w-full border border-grit bg-white px-2 text-sm text-graphite outline-none focus:border-brass-deep"
      >
        <option value="">Choose record</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }

  return (
    <input
      type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
      className="mt-1 block h-9 w-full border border-grit px-2 text-sm text-graphite outline-none focus:border-brass-deep"
    />
  );
}

function serializeCondition(condition: LocalCondition, fields: FieldDefinition[]): ProcessBranchCondition {
  const field = fields.find((candidate) => candidate.id === condition.sourceFieldDefinitionId);
  const needsValue = processConditionOperatorNeedsValue(condition.operator);

  if (!needsValue) {
    return {
      sourceFieldDefinitionId: condition.sourceFieldDefinitionId,
      operator: condition.operator,
    };
  }

  let value: string | number | boolean = condition.value;

  if (field?.type === "number") {
    value = Number(condition.value);
  } else if (field?.type === "boolean") {
    value = condition.value === "true";
  }

  return {
    sourceFieldDefinitionId: condition.sourceFieldDefinitionId,
    operator: condition.operator,
    value,
  };
}

export function ProcessTemplateForm({
  entityContexts,
  members,
  saveProcessTemplateAction,
  initialState,
  isEditing,
}: ProcessTemplateFormProps) {
  const [state, formAction, pending] = useActionState(saveProcessTemplateAction, initialState);
  const contextByEntityTypeId = useMemo(
    () => new Map(entityContexts.map((context) => [context.entityType.id, context])),
    [entityContexts],
  );
  const [appliesToEntityTypeId, setAppliesToEntityTypeId] = useState(
    state.values.appliesToEntityTypeId,
  );
  const [steps, setSteps] = useState<LocalStep[]>(() =>
    state.values.steps.map((step, index) => ({
      key: step.clientKey || step.nodeId || `step-${index + 1}`,
      nodeId: step.nodeId,
      nodeType: step.nodeType ?? "human_task",
      parallelGroupId: step.parallelGroupId ?? "",
      name: step.name,
      assigneeUserId: step.assigneeUserId,
      dueAmount: step.dueAmount,
      dueUnit: step.dueUnit === "hours" ? "hours" : "days",
      routes: step.routes.map(toLocalRoute),
    })),
  );
  const currentContext = contextByEntityTypeId.get(appliesToEntityTypeId);
  const activeFields = (currentContext?.fields ?? []).filter((field) => !field.archivedAt);

  function updateStep(key: string, updater: (step: LocalStep) => LocalStep) {
    setSteps((current) => current.map((step) => (step.key === key ? updater(step) : step)));
  }

  function updateRoute(
    stepKey: string,
    routeId: string,
    updater: (route: LocalRoute) => LocalRoute,
  ) {
    updateStep(stepKey, (step) => ({
      ...step,
      routes: step.routes.map((route) => (route.id === routeId ? updater(route) : route)),
    }));
  }

  function addStep() {
    const nextKey = createKey("step");

    setSteps((current) => {
      const previous = current.at(-1);
      const next: LocalStep[] = [
        ...current,
        {
          key: nextKey,
          nodeId: "",
          nodeType: "human_task" as const,
          parallelGroupId: "",
          name: "",
          assigneeUserId: "",
          dueAmount: "",
          dueUnit: "days" as const,
          routes: [],
        },
      ];

      if (!previous || previous.routes.length > 0) {
        return next;
      }

      return next.map((step) =>
        step.key === previous.key
          ? {
              ...step,
              routes: [
                {
                  id: createKey("route"),
                  targetStepKey: nextKey,
                  isDefault: true,
                  isParallel: false,
                  conditions: [],
                },
              ],
            }
          : step,
      );
    });
  }

  function addApproval() {
    const approvalKey = createKey("approval");
    const approvedKey = createKey("approval-approved");
    const rejectedKey = createKey("approval-rejected");

    setSteps((current) => {
      const previous = current.at(-1);
      const block: LocalStep[] = [
        {
          key: approvalKey,
          nodeId: "",
          nodeType: "approval",
          parallelGroupId: "",
          name: "Approval",
          assigneeUserId: "",
          dueAmount: "",
          dueUnit: "days",
          routes: [
            {
              id: createKey("route"),
              targetStepKey: approvedKey,
              isDefault: false,
              isParallel: false,
              approvalOutcomeId: crypto.randomUUID(),
              approvalOutcomeLabel: "Approve",
              conditions: [],
            },
            {
              id: createKey("route"),
              targetStepKey: rejectedKey,
              isDefault: false,
              isParallel: false,
              approvalOutcomeId: crypto.randomUUID(),
              approvalOutcomeLabel: "Reject",
              conditions: [],
            },
          ],
        },
        {
          key: approvedKey,
          nodeId: "",
          nodeType: "human_task",
          parallelGroupId: "",
          name: "Approved follow-up",
          assigneeUserId: "",
          dueAmount: "",
          dueUnit: "days",
          routes: [],
        },
        {
          key: rejectedKey,
          nodeId: "",
          nodeType: "human_task",
          parallelGroupId: "",
          name: "Rejected follow-up",
          assigneeUserId: "",
          dueAmount: "",
          dueUnit: "days",
          routes: [],
        },
      ];

      const withPrevious =
        previous && previous.routes.length === 0
          ? current.map((step) =>
              step.key === previous.key
                ? {
                    ...step,
                    routes: [
                      {
                        id: createKey("route"),
                        targetStepKey: approvalKey,
                        isDefault: true,
                        isParallel: false,
                        conditions: [],
                      },
                    ],
                  }
                : step,
            )
          : current;

      return [...withPrevious, ...block];
    });
  }

  function addParallelPaths() {
    const splitKey = createKey("parallel-split");
    const firstBranchKey = createKey("parallel-branch");
    const secondBranchKey = createKey("parallel-branch");
    const joinKey = createKey("parallel-join");
    const parallelGroupId = createParallelGroupId();

    setSteps((current) => {
      const previous = current.at(-1);
      const block: LocalStep[] = [
        {
          key: splitKey,
          nodeId: "",
          nodeType: "parallel_split",
          parallelGroupId,
          name: "Parallel paths",
          assigneeUserId: "",
          dueAmount: "",
          dueUnit: "days",
          routes: [
            {
              id: createKey("route"),
              targetStepKey: firstBranchKey,
              isDefault: false,
              isParallel: true,
              conditions: [],
            },
            {
              id: createKey("route"),
              targetStepKey: secondBranchKey,
              isDefault: false,
              isParallel: true,
              conditions: [],
            },
          ],
        },
        {
          key: firstBranchKey,
          nodeId: "",
          nodeType: "human_task",
          parallelGroupId: "",
          name: "First parallel task",
          assigneeUserId: "",
          dueAmount: "",
          dueUnit: "days",
          routes: [
            {
              id: createKey("route"),
              targetStepKey: joinKey,
              isDefault: true,
              isParallel: false,
              conditions: [],
            },
          ],
        },
        {
          key: secondBranchKey,
          nodeId: "",
          nodeType: "human_task",
          parallelGroupId: "",
          name: "Second parallel task",
          assigneeUserId: "",
          dueAmount: "",
          dueUnit: "days",
          routes: [
            {
              id: createKey("route"),
              targetStepKey: joinKey,
              isDefault: true,
              isParallel: false,
              conditions: [],
            },
          ],
        },
        {
          key: joinKey,
          nodeId: "",
          nodeType: "parallel_join",
          parallelGroupId,
          name: "Join parallel paths",
          assigneeUserId: "",
          dueAmount: "",
          dueUnit: "days",
          routes: [],
        },
      ];

      const withPrevious =
        previous && previous.routes.length === 0
          ? current.map((step) =>
              step.key === previous.key
                ? {
                    ...step,
                    routes: [
                      {
                        id: createKey("route"),
                        targetStepKey: splitKey,
                        isDefault: true,
                        isParallel: false,
                        conditions: [],
                      },
                    ],
                  }
                : step,
            )
          : current;

      return [...withPrevious, ...block];
    });
  }

  function removeStep(key: string) {
    setSteps((current) => {
      if (current.length <= 1) {
        return current;
      }

      const groupId = current.find((step) => step.key === key)?.parallelGroupId;
      const splitIndex = groupId
        ? current.findIndex(
            (step) => step.nodeType === "parallel_split" && step.parallelGroupId === groupId,
          )
        : -1;
      const joinIndex = groupId
        ? current.findIndex(
            (step) => step.nodeType === "parallel_join" && step.parallelGroupId === groupId,
          )
        : -1;
      const removedKeys = new Set(
        splitIndex >= 0 && joinIndex >= splitIndex
          ? current.slice(splitIndex, joinIndex + 1).map((step) => step.key)
          : [key],
      );

      return current
        .filter((step) => !removedKeys.has(step.key))
        .map((step) => ({
          ...step,
          routes: step.routes.filter((route) => !removedKeys.has(route.targetStepKey)),
        }));
    });
  }

  function moveStep(key: string, direction: "up" | "down") {
    setSteps((current) => {
      const index = current.findIndex((step) => step.key === key);
      const swapWith = direction === "up" ? index - 1 : index + 1;

      if (index < 0 || swapWith < 0 || swapWith >= current.length) {
        return current;
      }

      const next = [...current];
      [next[index], next[swapWith]] = [next[swapWith], next[index]];
      return next;
    });
  }

  function addApprovalOutcome(stepKey: string, targetStepKey: string) {
    updateStep(stepKey, (step) => ({
      ...step,
      routes: [
        ...step.routes,
        {
          id: createKey("route"),
          targetStepKey,
          isDefault: false,
          isParallel: false,
          approvalOutcomeId: crypto.randomUUID(),
          approvalOutcomeLabel: "New outcome",
          conditions: [],
        },
      ],
    }));
  }

  function addConditionalRoute(stepKey: string, nextTargetStepKey: string) {
    const field = activeFields[0];

    updateStep(stepKey, (step) => {
      const defaultRoute = step.routes.find((route) => route.isDefault) ?? {
        id: createKey("route"),
        targetStepKey: nextTargetStepKey,
        isDefault: true,
        isParallel: false,
        conditions: [],
      };
      const conditionalRoute: LocalRoute = {
        id: createKey("route"),
        targetStepKey: nextTargetStepKey,
        isDefault: false,
        isParallel: false,
        conditions: field
          ? [
              {
                id: createKey("condition"),
                sourceFieldDefinitionId: field.id,
                operator: getProcessConditionDefaultOperator(field),
                value: "",
              },
            ]
          : [],
      };

      return {
        ...step,
        routes: [
          ...step.routes.filter((route) => !route.isDefault),
          conditionalRoute,
          defaultRoute,
        ],
      };
    });
  }

  function addCondition(stepKey: string, routeId: string) {
    const field = activeFields[0];

    if (!field) {
      return;
    }

    updateRoute(stepKey, routeId, (route) => ({
      ...route,
      conditions: [
        ...route.conditions,
        {
          id: createKey("condition"),
          sourceFieldDefinitionId: field.id,
          operator: getProcessConditionDefaultOperator(field),
          value: "",
        },
      ],
    }));
  }

  const serializedSteps = JSON.stringify(
    steps.map((step) => ({
      clientKey: step.key,
      nodeId: step.nodeId,
      nodeType: step.nodeType,
      parallelGroupId: step.parallelGroupId,
      name: step.name,
      assigneeUserId: step.assigneeUserId,
      dueAmount: step.dueAmount,
      dueUnit: step.dueUnit,
      routes: step.routes.map((route) => ({
        id: route.id,
        targetStepKey: route.targetStepKey,
        isDefault: route.isDefault,
        isParallel: route.isParallel,
        approvalOutcomeId: route.approvalOutcomeId ?? "",
        approvalOutcomeLabel: route.approvalOutcomeLabel ?? "",
        conditions: route.conditions.map((condition) =>
          serializeCondition(condition, currentContext?.fields ?? []),
        ),
      })),
    })),
  );

  return (
    <section className="mx-auto w-full max-w-4xl border border-grit bg-white p-5">
      <div className="mb-5">
        <h1 className="text-2xl font-semibold text-graphite">
          {isEditing ? "Edit Process Template" : "New Process Template"}
        </h1>
        {state.message ? (
          <p
            className={`mt-2 text-sm ${state.success ? "text-status-sage" : "text-red-700"}`}
            role="status"
          >
            {state.message}
          </p>
        ) : null}
        <FieldError message={state.errors._form} />
      </div>

      <form action={formAction} className="flex flex-col gap-5">
        <input type="hidden" name="processSteps" value={serializedSteps} />
        <div>
          <label htmlFor="process-template-name" className="block text-sm font-medium text-slab">
            Name<span className="ml-1 text-red-700" aria-hidden="true">*</span>
          </label>
          <input
            id="process-template-name"
            name="name"
            type="text"
            required
            defaultValue={state.values.name}
            aria-invalid={state.errors.name ? "true" : "false"}
            className="mt-1 block h-10 w-full border border-grit px-3 text-sm text-graphite outline-none focus:border-brass-deep"
          />
          <FieldError message={state.errors.name} />
        </div>

        <div>
          <label htmlFor="process-template-description" className="block text-sm font-medium text-slab">
            Description
          </label>
          <textarea
            id="process-template-description"
            name="description"
            rows={2}
            defaultValue={state.values.description}
            className="mt-1 block w-full border border-grit px-3 py-2 text-sm text-graphite outline-none focus:border-brass-deep"
          />
        </div>

        <div>
          <label htmlFor="process-template-applies-to" className="block text-sm font-medium text-slab">
            Applies to<span className="ml-1 text-red-700" aria-hidden="true">*</span>
          </label>
          {isEditing ? (
            <>
              <input type="hidden" name="appliesToEntityTypeId" value={appliesToEntityTypeId} />
              <p className="mt-1 h-10 border border-grit bg-chalk px-3 py-2 text-sm text-stone">
                {currentContext?.entityType.name ?? "Unknown entity"}
              </p>
            </>
          ) : (
            <select
              id="process-template-applies-to"
              name="appliesToEntityTypeId"
              required
              value={appliesToEntityTypeId}
              onChange={(event) => setAppliesToEntityTypeId(event.currentTarget.value)}
              aria-invalid={state.errors.appliesToEntityTypeId ? "true" : "false"}
              className="mt-1 block h-10 w-full border border-grit bg-white px-3 text-sm text-graphite outline-none focus:border-brass-deep"
            >
              <option value="">Choose entity type</option>
              {entityContexts.map((context) => (
                <option key={context.entityType.id} value={context.entityType.id}>
                  {context.entityType.name}
                </option>
              ))}
            </select>
          )}
          <FieldError message={state.errors.appliesToEntityTypeId} />
        </div>

        <div>
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-graphite">Steps</h2>
              <p className="mt-1 text-sm text-stone">
                Steps stay in display order. Routes may only point forward in this list.
              </p>
            </div>
            <button
              type="button"
              onClick={addStep}
              className="border border-grit px-3 py-2 text-sm font-medium text-stone hover:border-brass-deep hover:text-brass-deep"
            >
              + Add step
            </button>
            <button
              type="button"
              onClick={addApproval}
              className="border border-grit px-3 py-2 text-sm font-medium text-stone hover:border-brass-deep hover:text-brass-deep"
            >
              + Add approval
            </button>
            <button
              type="button"
              onClick={addParallelPaths}
              className="border border-grit px-3 py-2 text-sm font-medium text-stone hover:border-brass-deep hover:text-brass-deep"
            >
              + Add parallel paths
            </button>
          </div>

          <div className="flex flex-col gap-4">
            {steps.map((step, index) => {
              const legalTargets = steps.slice(index + 1);
              const routeError = state.errors[`stepRoutes.${index}`];
              const hasConditionalRoutes = step.routes.some((route) => !route.isDefault);
              const isApproval = step.nodeType === "approval";

              if (step.nodeType === "parallel_split" || step.nodeType === "parallel_join") {
                const isSplit = step.nodeType === "parallel_split";

                return (
                  <div key={step.key} className="border border-dashed border-brass-deep/50 bg-brass-light/10 p-4">
                    <p className="text-xs font-medium uppercase tracking-wide text-brass-deep">
                      {isSplit ? "Parallel paths" : "Join parallel paths"}
                    </p>
                    <p className="mt-1 text-sm text-stone">
                      {isSplit
                        ? "Activates every configured branch at once."
                        : "Waits until every branch in this parallel group arrives."}
                    </p>
                    <button
                      type="button"
                      onClick={() => removeStep(step.key)}
                      className="mt-3 text-xs font-medium text-stone underline-offset-4 hover:text-red-700 hover:underline"
                    >
                      Remove parallel paths
                    </button>
                    <FieldError message={routeError} />
                  </div>
                );
              }

              return (
                <div key={step.key} className="border border-grit p-4">
                  <div className="flex items-end gap-2">
                    <div className="flex-1">
                      <label htmlFor={`step-name-${step.key}`} className="block text-xs font-medium uppercase tracking-wide text-stone">
                        {isApproval ? "Approval" : `Step ${index + 1}`}
                      </label>
                      <input
                        id={`step-name-${step.key}`}
                        name="stepName"
                        type="text"
                        required
                        value={step.name}
                        onChange={(event) => {
                          const name = event.currentTarget.value;
                          updateStep(step.key, (current) => ({ ...current, name }));
                        }}
                        className="mt-1 block h-10 w-full border border-grit px-3 text-sm text-graphite outline-none focus:border-brass-deep"
                      />
                    </div>
                    <button type="button" onClick={() => moveStep(step.key, "up")} disabled={index === 0} className="h-10 border border-grit px-2 text-xs font-medium text-stone hover:border-brass-deep hover:text-brass-deep disabled:cursor-not-allowed disabled:opacity-40">Move Up</button>
                    <button type="button" onClick={() => moveStep(step.key, "down")} disabled={index === steps.length - 1} className="h-10 border border-grit px-2 text-xs font-medium text-stone hover:border-brass-deep hover:text-brass-deep disabled:cursor-not-allowed disabled:opacity-40">Move Down</button>
                    <button type="button" onClick={() => removeStep(step.key)} disabled={steps.length <= 1} className="h-10 border border-grit px-2 text-xs font-medium text-stone hover:border-red-700 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-40">Remove</button>
                  </div>

                  <div className="mt-3 grid gap-3 md:grid-cols-2">
                    <div>
                      <label htmlFor={`step-assignee-${step.key}`} className="block text-xs font-medium uppercase tracking-wide text-stone">Assignee</label>
                      <select id={`step-assignee-${step.key}`} name="stepAssigneeUserId" value={step.assigneeUserId} onChange={(event) => {
                        const assigneeUserId = event.currentTarget.value;
                        updateStep(step.key, (current) => ({ ...current, assigneeUserId }));
                      }} className="mt-1 block h-9 w-full border border-grit bg-white px-2 text-sm text-graphite outline-none focus:border-brass-deep">
                        <option value="">Unassigned</option>
                        {members.map((member) => <option key={member.userId} value={member.userId}>{member.email}</option>)}
                      </select>
                    </div>
                    <fieldset>
                      <legend className="text-xs font-medium uppercase tracking-wide text-stone">Due</legend>
                      <div className="mt-1 flex items-center gap-2">
                        <input id={`step-due-amount-${step.key}`} name="stepDueAmount" type="number" min="1" max="8760" step="1" value={step.dueAmount} onChange={(event) => {
                          const dueAmount = event.currentTarget.value;
                          updateStep(step.key, (current) => ({ ...current, dueAmount }));
                        }} className="h-9 w-24 border border-grit px-2 text-sm text-graphite outline-none focus:border-brass-deep" />
                        <select aria-label={`Due unit for step ${index + 1}`} name="stepDueUnit" value={step.dueUnit} onChange={(event) => {
                          const dueUnit = event.currentTarget.value === "hours" ? "hours" : "days";
                          updateStep(step.key, (current) => ({ ...current, dueUnit }));
                        }} className="h-9 border border-grit bg-white px-2 text-sm text-graphite outline-none focus:border-brass-deep"><option value="hours">Hours</option><option value="days">Days</option></select>
                        <span className="text-sm text-stone">after activation</span>
                      </div>
                      <FieldError message={state.errors[`stepDueAmount.${index}`]} />
                    </fieldset>
                  </div>

                  {isApproval ? (
                    <fieldset className="mt-4 border-t border-grit pt-4">
                      <legend className="text-sm font-semibold text-graphite">Outcomes</legend>
                      {legalTargets.length === 0 ? (
                        <p className="mt-2 text-sm text-stone">
                          Add steps after this approval before configuring outcomes.
                        </p>
                      ) : (
                        <div className="mt-3 flex flex-col gap-3">
                          {step.routes.map((route, routeIndex) => (
                            <div key={route.id} className="grid gap-2 border border-grit bg-chalk p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                              <label className="text-sm text-stone">
                                <span className="block text-xs font-medium uppercase tracking-wide">Outcome {routeIndex + 1}</span>
                                <input
                                  value={route.approvalOutcomeLabel ?? ""}
                                  onChange={(event) => {
                                    const approvalOutcomeLabel = event.currentTarget.value;
                                    updateRoute(step.key, route.id, (currentRoute) => ({
                                      ...currentRoute,
                                      approvalOutcomeLabel,
                                    }));
                                  }}
                                  className="mt-1 block h-9 w-full border border-grit bg-white px-2 text-sm text-graphite outline-none focus:border-brass-deep"
                                />
                              </label>
                              <label className="text-sm text-stone">
                                <span className="block text-xs font-medium uppercase tracking-wide">Then</span>
                                <select
                                  value={route.targetStepKey}
                                  onChange={(event) => {
                                    const targetStepKey = event.currentTarget.value;
                                    updateRoute(step.key, route.id, (currentRoute) => ({
                                      ...currentRoute,
                                      targetStepKey,
                                    }));
                                  }}
                                  className="mt-1 block h-9 w-full border border-grit bg-white px-2 text-sm text-graphite outline-none focus:border-brass-deep"
                                >
                                  {legalTargets.map((target) => (
                                    <option key={target.key} value={target.key}>
                                      {target.name || "Untitled step"}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <button
                                type="button"
                                onClick={() =>
                                  updateStep(step.key, (current) => ({
                                    ...current,
                                    routes: current.routes.filter((candidate) => candidate.id !== route.id),
                                  }))
                                }
                                disabled={step.routes.length <= 2}
                                className="self-end h-9 text-xs font-medium text-stone underline-offset-4 hover:text-red-700 hover:underline disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                Remove
                              </button>
                            </div>
                          ))}
                          <button
                            type="button"
                            onClick={() => addApprovalOutcome(step.key, legalTargets[0].key)}
                            className="self-start text-sm font-medium text-stone underline-offset-4 hover:text-graphite hover:underline"
                          >
                            + Add outcome
                          </button>
                        </div>
                      )}
                      <FieldError message={routeError} />
                    </fieldset>
                  ) : legalTargets.length === 0 ? (
                    <p className="mt-4 border-t border-grit pt-3 text-sm text-stone">This is the terminal step.</p>
                  ) : (
                    <fieldset className="mt-4 border-t border-grit pt-4">
                      <legend className="text-sm font-semibold text-graphite">Next</legend>
                      {step.routes.length === 0 ? (
                        <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-stone">
                          <span>Continue to the next step.</span>
                          <button type="button" onClick={() => addConditionalRoute(step.key, legalTargets[0].key)} disabled={activeFields.length === 0} className="font-medium text-graphite underline-offset-4 hover:underline disabled:cursor-not-allowed disabled:opacity-40">Configure conditional routing</button>
                        </div>
                      ) : (
                        <div className="mt-3 flex flex-col gap-3">
                          {step.routes.filter((route) => !route.isDefault).map((route, routeIndex) => (
                            <div key={route.id} className="border border-grit bg-chalk p-3">
                              <div className="flex items-center justify-between gap-3">
                                <p className="text-xs font-medium uppercase tracking-wide text-stone">Route {routeIndex + 1}</p>
                                <button type="button" onClick={() => updateStep(step.key, (current) => ({ ...current, routes: current.routes.filter((candidate) => candidate.id !== route.id) }))} className="text-xs font-medium text-stone underline-offset-4 hover:text-red-700 hover:underline">Remove route</button>
                              </div>
                              <div className="mt-3 flex flex-col gap-3">
                                {route.conditions.map((condition) => {
                                  const selectedField = currentContext?.fields.find((field) => field.id === condition.sourceFieldDefinitionId);
                                  const visibleFields = (currentContext?.fields ?? []).filter((field) => !field.archivedAt || field.id === condition.sourceFieldDefinitionId);
                                  const operators = selectedField ? getProcessConditionOperatorsForFieldType(selectedField.type) : [];
                                  const selectedOperator = operators.includes(condition.operator) ? condition.operator : operators[0] ?? "equals";

                                  return (
                                    <div key={condition.id} className="grid gap-2 md:grid-cols-[1fr_180px_1fr_auto]">
                                      <select value={condition.sourceFieldDefinitionId} onChange={(event) => {
                                        const sourceFieldDefinitionId = event.currentTarget.value;
                                        const field = currentContext?.fields.find((candidate) => candidate.id === sourceFieldDefinitionId);
                                        updateRoute(step.key, route.id, (currentRoute) => ({ ...currentRoute, conditions: currentRoute.conditions.map((candidate) => candidate.id === condition.id ? { ...candidate, sourceFieldDefinitionId, operator: field ? getProcessConditionDefaultOperator(field) : "equals", value: "" } : candidate) }));
                                      }} className="h-9 border border-grit bg-white px-2 text-sm text-graphite outline-none focus:border-brass-deep">
                                        {visibleFields.map((field) => <option key={field.id} value={field.id}>{field.name}{field.archivedAt ? " (Archived)" : ""}</option>)}
                                      </select>
                                      <select value={selectedOperator} onChange={(event) => {
                                        const operator = event.currentTarget.value as ProcessBranchConditionOperator;
                                        updateRoute(step.key, route.id, (currentRoute) => ({ ...currentRoute, conditions: currentRoute.conditions.map((candidate) => candidate.id === condition.id ? { ...candidate, operator, value: "" } : candidate) }));
                                      }} className="h-9 border border-grit bg-white px-2 text-sm text-graphite outline-none focus:border-brass-deep">
                                        {operators.map((operator) => <option key={operator} value={operator}>{processConditionOperatorLabels[operator]}</option>)}
                                      </select>
                                      {selectedField && processConditionOperatorNeedsValue(selectedOperator) ? <ConditionValueInput field={selectedField} value={condition.value} options={currentContext?.relationOptionsByFieldId[selectedField.id] ?? []} onChange={(value) => updateRoute(step.key, route.id, (currentRoute) => ({ ...currentRoute, conditions: currentRoute.conditions.map((candidate) => candidate.id === condition.id ? { ...candidate, value } : candidate) }))} /> : <span className="self-center text-sm text-stone">No comparison value</span>}
                                      <button type="button" onClick={() => updateRoute(step.key, route.id, (currentRoute) => ({ ...currentRoute, conditions: currentRoute.conditions.filter((candidate) => candidate.id !== condition.id) }))} disabled={route.conditions.length <= 1} className="h-9 text-xs font-medium text-stone underline-offset-4 hover:text-red-700 hover:underline disabled:cursor-not-allowed disabled:opacity-40">Remove</button>
                                    </div>
                                  );
                                })}
                              </div>
                              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                                <button type="button" onClick={() => addCondition(step.key, route.id)} disabled={activeFields.length === 0} className="text-sm font-medium text-stone underline-offset-4 hover:text-graphite hover:underline disabled:cursor-not-allowed disabled:opacity-40">+ Add condition</button>
                                <label className="flex items-center gap-2 text-sm text-stone">Then <select value={route.targetStepKey} onChange={(event) => {
                                  const targetStepKey = event.currentTarget.value;
                                  updateRoute(step.key, route.id, (currentRoute) => ({ ...currentRoute, targetStepKey }));
                                }} className="h-9 border border-grit bg-white px-2 text-sm text-graphite outline-none focus:border-brass-deep">{legalTargets.map((target) => <option key={target.key} value={target.key}>{target.name || "Untitled step"}</option>)}</select></label>
                              </div>
                            </div>
                          ))}
                          {step.routes.find((route) => route.isDefault) ? (() => {
                            const defaultRoute = step.routes.find((route) => route.isDefault)!;
                            return <label className="flex flex-wrap items-center gap-2 text-sm font-medium text-graphite">{hasConditionalRoutes ? "Otherwise" : "Next"}<select value={defaultRoute.targetStepKey} onChange={(event) => {
                              const targetStepKey = event.currentTarget.value;
                              updateRoute(step.key, defaultRoute.id, (route) => ({ ...route, targetStepKey }));
                            }} className="h-9 border border-grit bg-white px-2 text-sm text-graphite outline-none focus:border-brass-deep">{legalTargets.map((target) => <option key={target.key} value={target.key}>{target.name || "Untitled step"}</option>)}</select></label>;
                          })() : null}
                          <button type="button" onClick={() => addConditionalRoute(step.key, legalTargets[0].key)} disabled={activeFields.length === 0} className="self-start text-sm font-medium text-stone underline-offset-4 hover:text-graphite hover:underline disabled:cursor-not-allowed disabled:opacity-40">+ Add route</button>
                        </div>
                      )}
                      <FieldError message={routeError} />
                    </fieldset>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-grit pt-4">
          <button type="submit" disabled={pending} className="inline-flex h-10 items-center justify-center bg-brass px-4 text-sm font-medium text-graphite hover:bg-brass-deep hover:text-paper disabled:cursor-not-allowed disabled:bg-chalk disabled:text-stone">
            {pending ? "Saving..." : "Save Process Template"}
          </button>
          <Link href="/processes" className="h-10 px-2 py-2 text-sm font-medium text-stone underline-offset-4 hover:underline">Cancel</Link>
        </div>
      </form>
    </section>
  );
}
