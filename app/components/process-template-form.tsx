"use client";

import Link from "next/link";
import { useActionState, useMemo, useState } from "react";
import { getProcessConditionDefaultOperator } from "@/lib/domain/process-conditions";
import type { ProcessTemplateFormState } from "@/lib/domain/process-validation";
import type { WorkspaceMemberIdentity } from "@/lib/domain/process-types";
import {
  FieldError,
  ParallelSystemNodeSummary,
  ProcessNodeEditor,
} from "./process-node-editor";
import { ProcessGraphView } from "./process-graph-view";
import type { ActionConfigProcessTemplateOption } from "./workflow-action-config-fields";
import {
  canSwapAdjacent,
  conditionWaitDefaults,
  createDefaultStep,
  createKey,
  createParallelGroupId,
  serializeCondition,
  toLocalCondition,
  toLocalRoute,
  waitDefaults,
} from "./process-template-shared";
import type {
  InsertableNodeType,
  LocalRoute,
  LocalStep,
  ProcessTemplateEntityContext,
} from "./process-template-shared";

export type { ProcessTemplateEntityContext } from "./process-template-shared";

type ProcessTemplateFormProps = {
  entityContexts: ProcessTemplateEntityContext[];
  members: WorkspaceMemberIdentity[];
  processTemplates: ActionConfigProcessTemplateOption[];
  saveProcessTemplateAction: (
    state: ProcessTemplateFormState,
    formData: FormData,
  ) => Promise<ProcessTemplateFormState>;
  initialState: ProcessTemplateFormState;
  isEditing: boolean;
};

export function ProcessTemplateForm({
  entityContexts,
  members,
  processTemplates,
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
      waitKind:
        step.waitKind === "weekdays" || step.waitKind === "calendar_target"
          ? step.waitKind
          : "duration",
      waitAmount: step.waitAmount ?? "",
      waitUnit: step.waitUnit === "calendar_days" ? "calendar_days" : "hours",
      waitTarget:
        step.waitTarget === "first_day_of_week_next_month" || step.waitTarget === "specific_datetime"
          ? step.waitTarget
          : "nth_weekday_next_month",
      waitOrdinal: step.waitOrdinal ?? "1",
      waitWeekday: step.waitWeekday ?? "1",
      waitDate: step.waitDate ?? "",
      waitTime: step.waitTime ?? "09:00",
      waitTimeZone: step.waitTimeZone ?? "America/Toronto",
      conditionWaitTargetKind:
        step.conditionWaitTargetKind === "related" ? "related" : "origin",
      conditionWaitRelationFieldDefinitionId: step.conditionWaitRelationFieldDefinitionId ?? "",
      conditionWaitTargetEntityTypeId: step.conditionWaitTargetEntityTypeId ?? "",
      conditionWaitConditions: (step.conditionWaitConditions ?? []).map(toLocalCondition),
      actionConfig: step.actionConfig,
      routes: step.routes.map(toLocalRoute),
    })),
  );
  const [viewMode, setViewMode] = useState<"list" | "graph">("list");
  const [selectedGraphKey, setSelectedGraphKey] = useState<string | null>(null);
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
          ...waitDefaults(),
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
          ...waitDefaults(),
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
          ...waitDefaults(),
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
          ...waitDefaults(),
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

  function addWait() {
    const waitKey = createKey("wait");

    setSteps((current) => {
      const previous = current.at(-1);
      const next: LocalStep = {
        key: waitKey,
        nodeId: "",
        nodeType: "wait",
        parallelGroupId: "",
        name: "Wait",
        assigneeUserId: "",
        dueAmount: "",
        dueUnit: "days",
        ...waitDefaults(),
        waitAmount: "1",
        routes: [],
      };

      const withRoute =
        previous && previous.routes.length === 0
          ? current.map((step) =>
              step.key === previous.key
                ? {
                    ...step,
                    routes: [{ id: createKey("route"), targetStepKey: waitKey, isDefault: true, isParallel: false, conditions: [] }],
                  }
                : step,
            )
          : current;

      return [...withRoute, next];
    });
  }

  function addConditionWait() {
    const waitKey = createKey("condition-wait");
    const field = activeFields[0];

    setSteps((current) => {
      const previous = current.at(-1);
      const next: LocalStep = {
        key: waitKey,
        nodeId: "",
        nodeType: "condition_wait",
        parallelGroupId: "",
        name: "Wait for condition",
        assigneeUserId: "",
        dueAmount: "",
        dueUnit: "days",
        ...waitDefaults(),
        ...conditionWaitDefaults(),
        conditionWaitConditions: field
          ? [{ id: createKey("condition"), sourceFieldDefinitionId: field.id, operator: getProcessConditionDefaultOperator(field), value: "" }]
          : [],
        routes: [],
      };
      const withRoute = previous && previous.routes.length === 0
        ? current.map((step) => step.key === previous.key
          ? { ...step, routes: [{ id: createKey("route"), targetStepKey: waitKey, isDefault: true, isParallel: false, conditions: [] }] }
          : step)
        : current;
      return [...withRoute, next];
    });
  }

  function addExternalEventWait() {
    const waitKey = createKey("external-event-wait");

    setSteps((current) => {
      const previous = current.at(-1);
      const next: LocalStep = createDefaultStep("external_event_wait", waitKey, activeFields);
      const withRoute = previous && previous.routes.length === 0
        ? current.map((step) => step.key === previous.key
          ? { ...step, routes: [{ id: createKey("route"), targetStepKey: waitKey, isDefault: true, isParallel: false, conditions: [] }] }
          : step)
        : current;
      return [...withRoute, next];
    });
  }

  function addAction() {
    const actionKey = createKey("action");

    setSteps((current) => {
      const previous = current.at(-1);
      const next: LocalStep = createDefaultStep("action", actionKey, activeFields);
      const withRoute =
        previous && previous.routes.length === 0
          ? current.map((step) =>
              step.key === previous.key
                ? {
                    ...step,
                    routes: [{ id: createKey("route"), targetStepKey: actionKey, isDefault: true, isParallel: false, conditions: [] }],
                  }
                : step,
            )
          : current;

      return [...withRoute, next];
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
          ...waitDefaults(),
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
          ...waitDefaults(),
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
          ...waitDefaults(),
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
          ...waitDefaults(),
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

      // Defensive: the UI already disables a move the guard rejects, but
      // moveStep itself never produces an order that breaks an existing
      // route's forward-only invariant, regardless of caller.
      if (!canSwapAdjacent(current, index, direction).allowed) {
        return current;
      }

      const next = [...current];
      [next[index], next[swapWith]] = [next[swapWith], next[index]];
      return next;
    });
  }

  // Deletes a step. When it has exactly one inbound route and exactly one
  // plain outbound route, the caller may choose to reconnect that single
  // inbound route straight to the outbound target instead of leaving it
  // dangling — see canReconnectOnDelete/reconnectTargetFor below, used by
  // the Graph view's explicit delete-choice UI. This never invents a rewire
  // for an ambiguous case; ambiguous deletes fall through to removeStep.
  function removeStepWithReconnect(key: string) {
    setSteps((current) => {
      const step = current.find((candidate) => candidate.key === key);
      const outbound = step?.routes.find(
        (route) => route.isDefault && !route.isParallel && !route.approvalOutcomeId,
      );

      if (!step || !outbound) {
        return current;
      }

      const newTarget = outbound.targetStepKey;

      return current
        .filter((candidate) => candidate.key !== key)
        .map((candidate) => ({
          ...candidate,
          routes: candidate.routes
            .map((route) =>
              route.targetStepKey === key ? { ...route, targetStepKey: newTarget } : route,
            )
            .filter((route) => route.targetStepKey !== key),
        }));
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

  // Splices a new node into an existing edge: source's route is retargeted
  // to the new node, and the new node gets a fresh route to the edge's old
  // target. Works uniformly for plain, conditional, approval-outcome, and
  // parallel-branch edges — only the clicked edge's target pointer changes,
  // its own type/conditions/outcome identity is untouched, and the new node
  // is inserted at the old target's current array index so the forward-only
  // ordering invariant holds automatically.
  function insertStepOnEdge(edgeId: string, nodeType: InsertableNodeType) {
    const newKey = createKey("step");

    setSteps((current) => {
      let sourceKey: string | undefined;
      let oldTarget: string | undefined;

      for (const step of current) {
        const route = step.routes.find((candidate) => candidate.id === edgeId);

        if (route) {
          sourceKey = step.key;
          oldTarget = route.targetStepKey;
          break;
        }
      }

      if (!sourceKey || !oldTarget) {
        return current;
      }

      const targetIndex = current.findIndex((step) => step.key === oldTarget);

      if (targetIndex === -1) {
        return current;
      }

      const newStep = createDefaultStep(nodeType, newKey, activeFields);

      newStep.routes =
        nodeType === "approval"
          ? [
              {
                id: createKey("route"),
                targetStepKey: oldTarget,
                isDefault: false,
                isParallel: false,
                approvalOutcomeId: crypto.randomUUID(),
                approvalOutcomeLabel: "Approve",
                conditions: [],
              },
              {
                id: createKey("route"),
                targetStepKey: oldTarget,
                isDefault: false,
                isParallel: false,
                approvalOutcomeId: crypto.randomUUID(),
                approvalOutcomeLabel: "Reject",
                conditions: [],
              },
            ]
          : [{ id: createKey("route"), targetStepKey: oldTarget, isDefault: true, isParallel: false, conditions: [] }];

      const rewired = current.map((step) =>
        step.key === sourceKey
          ? {
              ...step,
              routes: step.routes.map((route) =>
                route.id === edgeId ? { ...route, targetStepKey: newKey } : route,
              ),
            }
          : step,
      );
      const next = [...rewired];

      next.splice(targetIndex, 0, newStep);

      return next;
    });
    setSelectedGraphKey(newKey);
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
      waitKind: step.waitKind,
      waitAmount: step.waitAmount,
      waitUnit: step.waitUnit,
      waitTarget: step.waitTarget,
      waitOrdinal: step.waitOrdinal,
      waitWeekday: step.waitWeekday,
      waitDate: step.waitDate,
      waitTime: step.waitTime,
      waitTimeZone: step.waitTimeZone,
      conditionWaitTargetKind: step.conditionWaitTargetKind ?? "origin",
      conditionWaitRelationFieldDefinitionId: step.conditionWaitRelationFieldDefinitionId ?? "",
      conditionWaitTargetEntityTypeId: step.conditionWaitTargetEntityTypeId ?? "",
      conditionWaitConditions: (step.conditionWaitConditions ?? []).map((condition) =>
        serializeCondition(
          condition,
          (step.conditionWaitTargetKind === "related"
            ? contextByEntityTypeId.get(step.conditionWaitTargetEntityTypeId ?? "")?.fields
            : currentContext?.fields) ?? [],
        ),
      ),
      actionConfig: step.nodeType === "action" ? step.actionConfig : undefined,
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
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-graphite">Steps</h2>
              <p className="mt-1 text-sm text-stone">
                Steps stay in display order. Routes may only point forward in this list.
              </p>
            </div>
            <div className="flex items-center gap-1 border border-grit p-1" role="group" aria-label="Editor view">
              <button
                type="button"
                onClick={() => setViewMode("list")}
                aria-pressed={viewMode === "list"}
                className={`px-3 py-1.5 text-sm font-medium ${
                  viewMode === "list" ? "bg-brass text-graphite" : "text-stone hover:text-graphite"
                }`}
              >
                List
              </button>
              <button
                type="button"
                onClick={() => setViewMode("graph")}
                aria-pressed={viewMode === "graph"}
                className={`px-3 py-1.5 text-sm font-medium ${
                  viewMode === "graph" ? "bg-brass text-graphite" : "text-stone hover:text-graphite"
                }`}
              >
                Graph
              </button>
            </div>
          </div>

          <div className="mb-3 flex flex-wrap items-center gap-2">
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
              onClick={addWait}
              className="border border-grit px-3 py-2 text-sm font-medium text-stone hover:border-brass-deep hover:text-brass-deep"
            >
              + Add wait
            </button>
            <button
              type="button"
              onClick={addConditionWait}
              className="border border-grit px-3 py-2 text-sm font-medium text-stone hover:border-brass-deep hover:text-brass-deep"
            >
              + Add condition wait
            </button>
            <button
              type="button"
              onClick={addExternalEventWait}
              className="border border-grit px-3 py-2 text-sm font-medium text-stone hover:border-brass-deep hover:text-brass-deep"
            >
              + Add external event wait
            </button>
            <button
              type="button"
              onClick={addAction}
              className="border border-grit px-3 py-2 text-sm font-medium text-stone hover:border-brass-deep hover:text-brass-deep"
            >
              + Add action
            </button>
            <button
              type="button"
              onClick={addParallelPaths}
              className="border border-grit px-3 py-2 text-sm font-medium text-stone hover:border-brass-deep hover:text-brass-deep"
            >
              + Add parallel paths
            </button>
          </div>

          {viewMode === "list" ? (
            <div className="flex flex-col gap-4">
              {steps.map((step, index) => {
                const legalTargets = steps.slice(index + 1);
                const routeError = state.errors[`stepRoutes.${index}`];
                const isApproval = step.nodeType === "approval";
                const isWait = step.nodeType === "wait";
                const isConditionWait = step.nodeType === "condition_wait";
                const isExternalEventWait = step.nodeType === "external_event_wait";
                const isAction = step.nodeType === "action";

                if (step.nodeType === "parallel_split" || step.nodeType === "parallel_join") {
                  return (
                    <ParallelSystemNodeSummary
                      key={step.key}
                      step={step}
                      routeError={routeError}
                      onRemove={() => removeStep(step.key)}
                    />
                  );
                }

                return (
                  <div key={step.key} className="border border-grit p-4">
                    <div className="flex items-end gap-2">
                      <div className="flex-1">
                        <label htmlFor={`step-name-${step.key}`} className="block text-xs font-medium uppercase tracking-wide text-stone">
                          {isApproval
                            ? "Approval"
                            : isWait
                              ? "Wait"
                              : isConditionWait
                                ? "Condition wait"
                                : isExternalEventWait
                                  ? "External event wait"
                                  : isAction
                                    ? "Action"
                                    : `Step ${index + 1}`}
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
                      {(() => {
                        const upGuard = canSwapAdjacent(steps, index, "up");
                        const downGuard = canSwapAdjacent(steps, index, "down");

                        return (
                          <>
                            <button
                              type="button"
                              onClick={() => moveStep(step.key, "up")}
                              disabled={index === 0 || !upGuard.allowed}
                              title={index !== 0 && !upGuard.allowed ? upGuard.reason : undefined}
                              className="h-10 border border-grit px-2 text-xs font-medium text-stone hover:border-brass-deep hover:text-brass-deep disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              Move Up
                            </button>
                            <button
                              type="button"
                              onClick={() => moveStep(step.key, "down")}
                              disabled={index === steps.length - 1 || !downGuard.allowed}
                              title={
                                index !== steps.length - 1 && !downGuard.allowed
                                  ? downGuard.reason
                                  : undefined
                              }
                              className="h-10 border border-grit px-2 text-xs font-medium text-stone hover:border-brass-deep hover:text-brass-deep disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              Move Down
                            </button>
                          </>
                        );
                      })()}
                      <button type="button" onClick={() => removeStep(step.key)} disabled={steps.length <= 1} className="h-10 border border-grit px-2 text-xs font-medium text-stone hover:border-red-700 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-40">Remove</button>
                    </div>

                    <ProcessNodeEditor
                      step={step}
                      index={index}
                      legalTargets={legalTargets}
                      activeFields={activeFields}
                      currentContext={currentContext}
                      contextByEntityTypeId={contextByEntityTypeId}
                      members={members}
                      processTemplates={processTemplates}
                      routeError={routeError}
                      dueError={state.errors[`stepDueAmount.${index}`]}
                      updateStep={updateStep}
                      updateRoute={updateRoute}
                      addCondition={addCondition}
                      addConditionalRoute={addConditionalRoute}
                      addApprovalOutcome={addApprovalOutcome}
                    />
                  </div>
                );
              })}
            </div>
          ) : (
            <ProcessGraphView
              steps={steps}
              state={state}
              activeFields={activeFields}
              currentContext={currentContext}
              contextByEntityTypeId={contextByEntityTypeId}
              members={members}
              processTemplates={processTemplates}
              selectedKey={selectedGraphKey}
              onSelectKey={setSelectedGraphKey}
              updateStep={updateStep}
              updateRoute={updateRoute}
              addCondition={addCondition}
              addConditionalRoute={addConditionalRoute}
              addApprovalOutcome={addApprovalOutcome}
              removeStep={removeStep}
              removeStepWithReconnect={removeStepWithReconnect}
              moveStep={moveStep}
              insertStepOnEdge={insertStepOnEdge}
            />
          )}
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
