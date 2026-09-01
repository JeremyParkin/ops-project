"use client";

import { useMemo, useState } from "react";
import type { ProcessTemplateFormState } from "@/lib/domain/process-validation";
import type { FieldDefinition } from "@/lib/domain/types";
import type { WorkspaceMemberIdentity } from "@/lib/domain/process-types";
import { computeProcessGraphLayout, GRAPH_NODE_HEIGHT, GRAPH_NODE_WIDTH } from "./process-graph-layout";
import {
  NODE_TYPE_LABELS,
  summarizeConditionWaitRule,
  summarizeRouteLabel,
  summarizeWaitRule,
} from "./process-graph-summaries";
import { ProcessNodeEditor } from "./process-node-editor";
import type { ActionConfigProcessTemplateOption } from "./workflow-action-config-fields";
import {
  canSwapAdjacent,
  type InsertableNodeType,
  type LocalRoute,
  type LocalStep,
  type ProcessTemplateEntityContext,
} from "./process-template-shared";

type ProcessGraphViewProps = {
  steps: LocalStep[];
  state: ProcessTemplateFormState;
  activeFields: FieldDefinition[];
  currentContext?: ProcessTemplateEntityContext;
  contextByEntityTypeId: Map<string, ProcessTemplateEntityContext>;
  members: WorkspaceMemberIdentity[];
  processTemplates: ActionConfigProcessTemplateOption[];
  selectedKey: string | null;
  onSelectKey: (key: string | null) => void;
  updateStep: (key: string, updater: (step: LocalStep) => LocalStep) => void;
  updateRoute: (stepKey: string, routeId: string, updater: (route: LocalRoute) => LocalRoute) => void;
  addCondition: (stepKey: string, routeId: string) => void;
  addConditionalRoute: (stepKey: string, targetStepKey: string) => void;
  addApprovalOutcome: (stepKey: string, targetStepKey: string) => void;
  removeStep: (key: string) => void;
  removeStepWithReconnect: (key: string) => void;
  moveStep: (key: string, direction: "up" | "down") => void;
  insertStepOnEdge: (edgeId: string, nodeType: InsertableNodeType) => void;
};

const NODE_TYPE_ACCENT: Record<LocalStep["nodeType"], string> = {
  human_task: "border-grit",
  approval: "border-brass-deep",
  wait: "border-status-slate",
  condition_wait: "border-status-slate",
  external_event_wait: "border-status-slate",
  action: "border-status-slate",
  parallel_split: "border-brass-deep border-dashed",
  parallel_join: "border-brass-deep border-dashed",
};

const INSERTABLE_TYPE_LABELS: Record<InsertableNodeType, string> = {
  human_task: "Human task",
  approval: "Approval",
  wait: "Wait",
  condition_wait: "Condition wait",
  external_event_wait: "External event wait",
  action: "Action",
};

function nodeSummary(step: LocalStep, members: WorkspaceMemberIdentity[]): string {
  if (step.nodeType === "wait") {
    return summarizeWaitRule(step);
  }

  if (step.nodeType === "condition_wait") {
    return summarizeConditionWaitRule(step);
  }

  if (step.nodeType === "action") {
    return "Runs automatically";
  }

  if (step.nodeType === "external_event_wait") {
    return "Waiting for external event";
  }

  if (step.nodeType === "parallel_split") {
    return "Activates every branch at once";
  }

  if (step.nodeType === "parallel_join") {
    return "Waits for every branch to arrive";
  }

  if (!step.assigneeUserId) {
    return "Unassigned";
  }

  return members.find((member) => member.userId === step.assigneeUserId)?.email ?? "Unassigned";
}

// A node is reconnect-eligible for delete only when unambiguous: exactly
// one inbound route from anywhere, and the node's own routes are exactly
// one plain (non-conditional, non-parallel, non-outcome) default route.
// Anything else — including every system/approval node — is ambiguous and
// never gets an invented rewire.
function getDeleteChoice(steps: LocalStep[], key: string) {
  const step = steps.find((candidate) => candidate.key === key);

  if (!step || step.nodeType === "parallel_split" || step.nodeType === "parallel_join") {
    return { reconnectable: false as const };
  }

  const inbound = steps.flatMap((candidate) =>
    candidate.routes
      .filter((route) => route.targetStepKey === key)
      .map((route) => ({ source: candidate, route })),
  );
  const isPlainDefault = (route: LocalRoute) =>
    route.isDefault && !route.isParallel && !route.approvalOutcomeId;

  if (inbound.length !== 1 || step.routes.length !== 1 || !isPlainDefault(step.routes[0])) {
    return { reconnectable: false as const };
  }

  const targetKey = step.routes[0].targetStepKey;
  const targetStep = steps.find((candidate) => candidate.key === targetKey);

  return {
    reconnectable: true as const,
    fromName: inbound[0].source.name || "the previous step",
    toName: targetStep?.name || "the next step",
  };
}

export function ProcessGraphView({
  steps,
  state,
  activeFields,
  currentContext,
  contextByEntityTypeId,
  members,
  processTemplates,
  selectedKey,
  onSelectKey,
  updateStep,
  updateRoute,
  addCondition,
  addConditionalRoute,
  addApprovalOutcome,
  removeStep,
  removeStepWithReconnect,
  moveStep,
  insertStepOnEdge,
}: ProcessGraphViewProps) {
  const [confirmingDeleteKey, setConfirmingDeleteKey] = useState<string | null>(null);
  const [highlightRouteId, setHighlightRouteId] = useState<string | null>(null);
  const [insertMenuEdgeId, setInsertMenuEdgeId] = useState<string | null>(null);

  const layout = useMemo(() => computeProcessGraphLayout(steps), [steps]);
  const stepByKey = useMemo(() => new Map(steps.map((step) => [step.key, step])), [steps]);
  const stepIndexByKey = useMemo(() => new Map(steps.map((step, index) => [step.key, index])), [steps]);

  function selectNode(key: string | null) {
    onSelectKey(key);
    setConfirmingDeleteKey(null);
    setHighlightRouteId(null);
  }

  function selectRoute(sourceKey: string, routeId: string) {
    onSelectKey(sourceKey);
    setConfirmingDeleteKey(null);
    setHighlightRouteId(routeId);
  }

  function requestDelete(key: string) {
    const choice = getDeleteChoice(steps, key);

    onSelectKey(key);
    setHighlightRouteId(null);

    if (choice.reconnectable) {
      setConfirmingDeleteKey(key);
    } else {
      setConfirmingDeleteKey(null);
      removeStep(key);
      onSelectKey(null);
    }
  }

  if (steps.length === 0) {
    return <p className="border border-grit bg-white p-4 text-sm text-stone">No steps yet.</p>;
  }

  const selectedStep = selectedKey ? stepByKey.get(selectedKey) : undefined;
  const selectedIndex = selectedStep ? stepIndexByKey.get(selectedStep.key) ?? 0 : 0;
  const deleteChoice = selectedStep ? getDeleteChoice(steps, selectedStep.key) : { reconnectable: false as const };

  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      <div className="min-w-0 flex-1 overflow-auto border border-grit bg-paper" style={{ maxHeight: "70vh" }}>
        <div className="relative" style={{ width: layout.width, height: layout.height }}>
          <svg
            className="absolute left-0 top-0"
            width={layout.width}
            height={layout.height}
            role="presentation"
            aria-hidden="true"
          >
            {layout.edges.map((edge) => {
              const sourceStep = stepByKey.get(edge.sourceKey);
              const route = sourceStep?.routes.find((candidate) => candidate.id === edge.id);

              if (!sourceStep || !route) {
                return null;
              }

              const conditionFields =
                sourceStep.nodeType === "condition_wait"
                  ? ((sourceStep.conditionWaitTargetKind === "related"
                      ? contextByEntityTypeId.get(sourceStep.conditionWaitTargetEntityTypeId ?? "")?.fields
                      : currentContext?.fields) ?? [])
                  : currentContext?.fields ?? [];
              const label = summarizeRouteLabel(route, sourceStep, conditionFields);
              const isHighlighted = highlightRouteId === edge.id;

              return (
                <path
                  key={edge.id}
                  d={edge.path}
                  fill="none"
                  stroke={isHighlighted ? "var(--color-brass-deep)" : label ? "var(--color-stone)" : "var(--color-grit)"}
                  strokeWidth={isHighlighted ? 2.5 : edge.isParallel ? 2 : 1.5}
                  strokeDasharray={route.isDefault && label ? "4 3" : undefined}
                />
              );
            })}
          </svg>

          {layout.nodes.map((node) => {
            const step = stepByKey.get(node.key);

            if (!step) {
              return null;
            }

            const index = stepIndexByKey.get(step.key) ?? 0;
            const routeError = state.errors[`stepRoutes.${index}`];
            const isSelected = selectedKey === step.key;
            const upGuard = canSwapAdjacent(steps, index, "up");
            const downGuard = canSwapAdjacent(steps, index, "down");

            return (
              <div
                key={step.key}
                className="absolute"
                style={{ left: node.x, top: node.y, width: GRAPH_NODE_WIDTH, height: GRAPH_NODE_HEIGHT }}
              >
                <button
                  type="button"
                  onClick={() => selectNode(step.key)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      selectNode(null);
                    }
                  }}
                  aria-pressed={isSelected}
                  aria-label={`${NODE_TYPE_LABELS[step.nodeType]}: ${step.name || "Untitled step"}`}
                  className={`flex h-full w-full flex-col items-start gap-1 overflow-hidden border-2 bg-white p-3 text-left shadow-sm ${
                    isSelected ? "border-brass-deep" : NODE_TYPE_ACCENT[step.nodeType]
                  } ${routeError ? "outline outline-2 outline-offset-2 outline-red-700" : ""}`}
                >
                  <span className="text-[10px] font-medium uppercase tracking-wide text-brass-deep">
                    {NODE_TYPE_LABELS[step.nodeType]}
                  </span>
                  <span className="line-clamp-1 text-sm font-semibold text-graphite">
                    {step.name || "Untitled step"}
                  </span>
                  <span className="line-clamp-2 text-xs text-stone">{nodeSummary(step, members)}</span>
                </button>

                <div className="absolute -right-2 -top-2 flex gap-0.5">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      moveStep(step.key, "up");
                    }}
                    disabled={index === 0 || !upGuard.allowed}
                    title={index !== 0 && !upGuard.allowed ? upGuard.reason : "Move up"}
                    aria-label={`Move ${step.name || "step"} up`}
                    className="h-5 w-5 border border-grit bg-white text-[10px] leading-none text-stone hover:border-brass-deep hover:text-brass-deep disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      moveStep(step.key, "down");
                    }}
                    disabled={index === steps.length - 1 || !downGuard.allowed}
                    title={
                      index !== steps.length - 1 && !downGuard.allowed ? downGuard.reason : "Move down"
                    }
                    aria-label={`Move ${step.name || "step"} down`}
                    className="h-5 w-5 border border-grit bg-white text-[10px] leading-none text-stone hover:border-brass-deep hover:text-brass-deep disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      requestDelete(step.key);
                    }}
                    disabled={steps.length <= 1}
                    title="Delete"
                    aria-label={`Delete ${step.name || "step"}`}
                    className="h-5 w-5 border border-grit bg-white text-[10px] leading-none text-stone hover:border-red-700 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    ×
                  </button>
                </div>
              </div>
            );
          })}

          {layout.edges.map((edge) => {
            const sourceStep = stepByKey.get(edge.sourceKey);
            const targetStep = stepByKey.get(edge.targetKey);
            const route = sourceStep?.routes.find((candidate) => candidate.id === edge.id);

            if (!sourceStep || !route) {
              return null;
            }

            const conditionFields =
              sourceStep.nodeType === "condition_wait"
                ? ((sourceStep.conditionWaitTargetKind === "related"
                    ? contextByEntityTypeId.get(sourceStep.conditionWaitTargetEntityTypeId ?? "")?.fields
                    : currentContext?.fields) ?? [])
                : currentContext?.fields ?? [];
            const label = summarizeRouteLabel(route, sourceStep, conditionFields);
            const isMenuOpen = insertMenuEdgeId === edge.id;

            return (
              <div key={edge.id}>
                <button
                  type="button"
                  onClick={() => selectRoute(edge.sourceKey, edge.id)}
                  className={`absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap border px-1.5 py-0.5 text-[11px] ${
                    highlightRouteId === edge.id
                      ? "border-brass-deep bg-brass-light/30 text-brass-deep"
                      : "border-grit bg-paper text-stone hover:border-brass-deep hover:text-brass-deep"
                  }`}
                  style={{ left: edge.labelX, top: edge.labelY }}
                  aria-label={`Edit route from ${sourceStep.name || "step"} to ${targetStep?.name || "step"}${label ? `: ${label}` : ""}`}
                >
                  {label || "route"}
                </button>

                <button
                  type="button"
                  onClick={() => setInsertMenuEdgeId(isMenuOpen ? null : edge.id)}
                  className="absolute flex h-4 w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-grit bg-white text-[10px] leading-none text-stone hover:border-brass-deep hover:text-brass-deep"
                  style={{ left: edge.insertX, top: edge.insertY }}
                  aria-label={`Insert a step between ${sourceStep.name || "step"} and ${targetStep?.name || "step"}`}
                  aria-expanded={isMenuOpen}
                >
                  +
                </button>

                {isMenuOpen ? (
                  <div
                    role="menu"
                    aria-label="Choose a step type to insert"
                    className="absolute z-10 flex flex-col border border-grit bg-white shadow-sm"
                    style={{ left: edge.insertX + 10, top: edge.insertY }}
                  >
                    {(Object.keys(INSERTABLE_TYPE_LABELS) as InsertableNodeType[]).map((nodeType) => (
                      <button
                        key={nodeType}
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          insertStepOnEdge(edge.id, nodeType);
                          setInsertMenuEdgeId(null);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            setInsertMenuEdgeId(null);
                          }
                        }}
                        className="whitespace-nowrap px-3 py-1.5 text-left text-xs font-medium text-stone hover:bg-chalk hover:text-graphite"
                      >
                        {INSERTABLE_TYPE_LABELS[nodeType]}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      <div
        className="w-full flex-shrink-0 border border-grit bg-white p-4 lg:w-96"
        role="region"
        aria-label="Selected step"
      >
        {!selectedStep ? (
          <p className="text-sm text-stone">Select a step on the graph to view and edit its details.</p>
        ) : (
          <div>
            <div className="mb-4 flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <label
                  htmlFor={`graph-step-name-${selectedStep.key}`}
                  className="block text-xs font-medium uppercase tracking-wide text-stone"
                >
                  {NODE_TYPE_LABELS[selectedStep.nodeType]}
                </label>
                {selectedStep.nodeType !== "parallel_split" && selectedStep.nodeType !== "parallel_join" ? (
                  <input
                    id={`graph-step-name-${selectedStep.key}`}
                    type="text"
                    value={selectedStep.name}
                    onChange={(event) => {
                      const name = event.currentTarget.value;
                      updateStep(selectedStep.key, (current) => ({ ...current, name }));
                    }}
                    className="mt-1 block h-10 w-full border border-grit px-3 text-sm text-graphite outline-none focus:border-brass-deep"
                  />
                ) : (
                  <p className="mt-1 text-sm font-semibold text-graphite">{selectedStep.name}</p>
                )}
              </div>
              {confirmingDeleteKey !== selectedStep.key ? (
                <button
                  type="button"
                  onClick={() => requestDelete(selectedStep.key)}
                  disabled={steps.length <= 1}
                  className="h-10 border border-grit px-2 text-xs font-medium text-stone hover:border-red-700 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Remove
                </button>
              ) : null}
            </div>

            {confirmingDeleteKey === selectedStep.key && deleteChoice.reconnectable ? (
              <div className="mb-4 border border-red-700/40 bg-red-700/5 p-3">
                <p className="text-sm text-graphite">Delete &quot;{selectedStep.name || "this step"}&quot;?</p>
                <div className="mt-3 flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      removeStepWithReconnect(selectedStep.key);
                      onSelectKey(null);
                      setConfirmingDeleteKey(null);
                    }}
                    className="inline-flex h-9 items-center justify-center bg-brass px-3 text-sm font-medium text-graphite hover:bg-brass-deep hover:text-paper"
                  >
                    Delete and reconnect &quot;{deleteChoice.fromName}&quot; to &quot;{deleteChoice.toName}&quot;
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      removeStep(selectedStep.key);
                      onSelectKey(null);
                      setConfirmingDeleteKey(null);
                    }}
                    className="inline-flex h-9 items-center justify-center border border-grit px-3 text-sm font-medium text-stone hover:border-red-700 hover:text-red-700"
                  >
                    Delete without reconnecting
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingDeleteKey(null)}
                    className="self-start text-xs font-medium text-stone underline-offset-4 hover:text-graphite hover:underline"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}

            {selectedStep.nodeType === "parallel_split" || selectedStep.nodeType === "parallel_join" ? (
              <p className="text-sm text-stone">
                {selectedStep.nodeType === "parallel_split"
                  ? "Activates every configured branch at once. Edit each branch from its own step."
                  : "Waits until every branch in this parallel group arrives, then continues."}
              </p>
            ) : (
              <ProcessNodeEditor
                step={selectedStep}
                index={selectedIndex}
                legalTargets={steps.slice(selectedIndex + 1)}
                activeFields={activeFields}
                currentContext={currentContext}
                contextByEntityTypeId={contextByEntityTypeId}
                members={members}
                processTemplates={processTemplates}
                routeError={state.errors[`stepRoutes.${selectedIndex}`]}
                dueError={state.errors[`stepDueAmount.${selectedIndex}`]}
                highlightRouteId={highlightRouteId}
                updateStep={updateStep}
                updateRoute={updateRoute}
                addCondition={addCondition}
                addConditionalRoute={addConditionalRoute}
                addApprovalOutcome={addApprovalOutcome}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
