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
import type { LocalRoute, LocalStep, ProcessTemplateEntityContext } from "./process-template-shared";

type ProcessGraphViewProps = {
  steps: LocalStep[];
  state: ProcessTemplateFormState;
  activeFields: FieldDefinition[];
  currentContext?: ProcessTemplateEntityContext;
  contextByEntityTypeId: Map<string, ProcessTemplateEntityContext>;
  members: WorkspaceMemberIdentity[];
  updateStep: (key: string, updater: (step: LocalStep) => LocalStep) => void;
  updateRoute: (stepKey: string, routeId: string, updater: (route: LocalRoute) => LocalRoute) => void;
  addCondition: (stepKey: string, routeId: string) => void;
  addConditionalRoute: (stepKey: string, targetStepKey: string) => void;
  addApprovalOutcome: (stepKey: string, targetStepKey: string) => void;
  removeStep: (key: string) => void;
};

const NODE_TYPE_ACCENT: Record<LocalStep["nodeType"], string> = {
  human_task: "border-grit",
  approval: "border-brass-deep",
  wait: "border-status-slate",
  condition_wait: "border-status-slate",
  parallel_split: "border-brass-deep border-dashed",
  parallel_join: "border-brass-deep border-dashed",
};

function nodeSummary(step: LocalStep, members: WorkspaceMemberIdentity[]): string {
  if (step.nodeType === "wait") {
    return summarizeWaitRule(step);
  }

  if (step.nodeType === "condition_wait") {
    return summarizeConditionWaitRule(step);
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

export function ProcessGraphView({
  steps,
  state,
  activeFields,
  currentContext,
  contextByEntityTypeId,
  members,
  updateStep,
  updateRoute,
  addCondition,
  addConditionalRoute,
  addApprovalOutcome,
  removeStep,
}: ProcessGraphViewProps) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const layout = useMemo(() => computeProcessGraphLayout(steps), [steps]);
  const nodeByKey = useMemo(() => new Map(layout.nodes.map((node) => [node.key, node])), [layout]);
  const stepByKey = useMemo(() => new Map(steps.map((step) => [step.key, step])), [steps]);
  const stepIndexByKey = useMemo(() => new Map(steps.map((step, index) => [step.key, index])), [steps]);

  if (steps.length === 0) {
    return <p className="border border-grit bg-white p-4 text-sm text-stone">No steps yet.</p>;
  }

  const selectedStep = selectedKey ? stepByKey.get(selectedKey) : undefined;
  const selectedIndex = selectedStep ? stepIndexByKey.get(selectedStep.key) ?? 0 : 0;

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
              const source = nodeByKey.get(edge.sourceKey);
              const target = nodeByKey.get(edge.targetKey);
              const sourceStep = stepByKey.get(edge.sourceKey);
              const route = sourceStep?.routes.find((candidate) => candidate.id === edge.id);

              if (!source || !target || !sourceStep || !route) {
                return null;
              }

              const conditionFields =
                sourceStep.nodeType === "condition_wait"
                  ? ((sourceStep.conditionWaitTargetKind === "related"
                      ? contextByEntityTypeId.get(sourceStep.conditionWaitTargetEntityTypeId ?? "")?.fields
                      : currentContext?.fields) ?? [])
                  : currentContext?.fields ?? [];
              const label = summarizeRouteLabel(route, sourceStep, conditionFields);

              const x1 = source.x + GRAPH_NODE_WIDTH / 2;
              const y1 = source.y + GRAPH_NODE_HEIGHT;
              const x2 = target.x + GRAPH_NODE_WIDTH / 2;
              const y2 = target.y;
              const midX = (x1 + x2) / 2;
              const midY = (y1 + y2) / 2;

              return (
                <g key={edge.id}>
                  <path
                    d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
                    fill="none"
                    stroke={label ? "var(--color-stone)" : "var(--color-grit)"}
                    strokeWidth={edge.isParallel ? 2 : 1.5}
                    strokeDasharray={route.isDefault && label ? "4 3" : undefined}
                  />
                  {label ? (
                    <text x={midX} y={midY - 6} textAnchor="middle" fontSize="11" fill="var(--color-stone)">
                      {label}
                    </text>
                  ) : null}
                </g>
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

            return (
              <button
                key={step.key}
                type="button"
                onClick={() => setSelectedKey(step.key)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setSelectedKey(null);
                  }
                }}
                aria-pressed={isSelected}
                aria-label={`${NODE_TYPE_LABELS[step.nodeType]}: ${step.name || "Untitled step"}`}
                className={`absolute flex flex-col items-start gap-1 overflow-hidden border-2 bg-white p-3 text-left shadow-sm ${
                  isSelected ? "border-brass-deep" : NODE_TYPE_ACCENT[step.nodeType]
                } ${routeError ? "outline outline-2 outline-offset-2 outline-red-700" : ""}`}
                style={{ left: node.x, top: node.y, width: GRAPH_NODE_WIDTH, height: GRAPH_NODE_HEIGHT }}
              >
                <span className="text-[10px] font-medium uppercase tracking-wide text-brass-deep">
                  {NODE_TYPE_LABELS[step.nodeType]}
                </span>
                <span className="line-clamp-1 text-sm font-semibold text-graphite">
                  {step.name || "Untitled step"}
                </span>
                <span className="line-clamp-2 text-xs text-stone">{nodeSummary(step, members)}</span>
              </button>
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
              <button
                type="button"
                onClick={() => {
                  removeStep(selectedStep.key);
                  setSelectedKey(null);
                }}
                disabled={steps.length <= 1}
                className="h-10 border border-grit px-2 text-xs font-medium text-stone hover:border-red-700 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Remove
              </button>
            </div>

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
                routeError={state.errors[`stepRoutes.${selectedIndex}`]}
                dueError={state.errors[`stepDueAmount.${selectedIndex}`]}
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
