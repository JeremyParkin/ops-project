"use client";

import { useEffect, useRef, type ReactNode } from "react";
import {
  getProcessConditionDefaultOperator,
  getProcessConditionOperatorsForFieldType,
  processConditionOperatorLabels,
  processConditionOperatorNeedsValue,
} from "@/lib/domain/process-conditions";
import type { ProcessBranchConditionOperator } from "@/lib/domain/process-types";
import type { FieldDefinition } from "@/lib/domain/types";
import type { RelationRecordOption } from "@/lib/domain/record-repository";
import type { WorkspaceMemberIdentity } from "@/lib/domain/process-types";
import type {
  LocalRoute,
  LocalStep,
  ProcessTemplateEntityContext,
} from "./process-template-shared";
import { createKey } from "./process-template-shared";
import {
  WorkflowActionConfigFields,
  type ActionConfigProcessTemplateOption,
} from "./workflow-action-config-fields";
import type { WorkflowAction } from "@/lib/domain/workflow-types";

export function FieldError({ message }: { message?: string }) {
  return message ? (
    <p className="mt-1 text-sm text-red-700" role="alert">
      {message}
    </p>
  ) : null;
}

// Wraps one route/outcome row so the Graph view's "edit this route" edge
// click can scroll it into view and give it a visible ring, without the
// List view (which never sets highlightRouteId) rendering any differently.
function HighlightableRoute({
  routeId,
  highlightRouteId,
  className,
  children,
}: {
  routeId: string;
  highlightRouteId?: string | null;
  className: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const isHighlighted = highlightRouteId === routeId;

  useEffect(() => {
    if (isHighlighted) {
      ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [isHighlighted]);

  return (
    <div ref={ref} className={`${className} ${isHighlighted ? "ring-2 ring-brass-deep" : ""}`}>
      {children}
    </div>
  );
}

export function ConditionValueInput({
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

type StepUpdater = (key: string, updater: (step: LocalStep) => LocalStep) => void;
type RouteUpdater = (
  stepKey: string,
  routeId: string,
  updater: (route: LocalRoute) => LocalRoute,
) => void;

export function ParallelSystemNodeSummary({
  step,
  routeError,
  onRemove,
}: {
  step: LocalStep;
  routeError?: string;
  onRemove: () => void;
}) {
  const isSplit = step.nodeType === "parallel_split";

  return (
    <div className="border border-dashed border-brass-deep/50 bg-brass-light/10 p-4">
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
        onClick={onRemove}
        className="mt-3 text-xs font-medium text-stone underline-offset-4 hover:text-red-700 hover:underline"
      >
        Remove parallel paths
      </button>
      <FieldError message={routeError} />
    </div>
  );
}

export function WaitConfigFields({
  step,
  updateStep,
  routeError,
}: {
  step: LocalStep;
  updateStep: StepUpdater;
  routeError?: string;
}) {
  return (
    <fieldset className="mt-3 border-t border-grit pt-3">
      <legend className="text-xs font-medium uppercase tracking-wide text-stone">Wait configuration</legend>
      <div className="mt-2 grid gap-3 md:grid-cols-2">
        <label className="text-sm text-stone">Mode
          <select value={step.waitKind} onChange={(event) => {
            const waitKind = event.currentTarget.value as LocalStep["waitKind"];
            updateStep(step.key, (current) => ({ ...current, waitKind }));
          }} className="mt-1 block h-9 w-full border border-grit bg-white px-2 text-sm text-graphite outline-none focus:border-brass-deep">
            <option value="duration">Duration</option>
            <option value="weekdays">Weekdays</option>
            <option value="calendar_target">Calendar target</option>
          </select>
        </label>
        {step.waitKind === "calendar_target" ? (
          <label className="text-sm text-stone">Rule
            <select value={step.waitTarget} onChange={(event) => {
              const waitTarget = event.currentTarget.value as LocalStep["waitTarget"];
              updateStep(step.key, (current) => ({ ...current, waitTarget }));
            }} className="mt-1 block h-9 w-full border border-grit bg-white px-2 text-sm text-graphite outline-none focus:border-brass-deep">
              <option value="nth_weekday_next_month">Nth weekday of next month</option>
              <option value="first_day_of_week_next_month">First day of week next month</option>
              <option value="specific_datetime">Specific date and time</option>
            </select>
          </label>
        ) : (
          <label className="text-sm text-stone">Amount
            <input type="number" min="1" max="8760" step="1" value={step.waitAmount} onChange={(event) => {
              const waitAmount = event.currentTarget.value;
              updateStep(step.key, (current) => ({ ...current, waitAmount }));
            }} className="mt-1 block h-9 w-full border border-grit px-2 text-sm text-graphite outline-none focus:border-brass-deep" />
          </label>
        )}
        {step.waitKind === "duration" ? (
          <label className="text-sm text-stone">Unit
            <select value={step.waitUnit} onChange={(event) => {
              const waitUnit = event.currentTarget.value === "calendar_days" ? "calendar_days" : "hours";
              updateStep(step.key, (current) => ({ ...current, waitUnit }));
            }} className="mt-1 block h-9 w-full border border-grit bg-white px-2 text-sm text-graphite outline-none focus:border-brass-deep"><option value="hours">Hours</option><option value="calendar_days">Calendar days</option></select>
          </label>
        ) : null}
        {step.waitKind === "calendar_target" && step.waitTarget === "nth_weekday_next_month" ? (
          <label className="text-sm text-stone">Weekday number
            <input type="number" min="1" max="20" step="1" value={step.waitOrdinal} onChange={(event) => {
              const waitOrdinal = event.currentTarget.value;
              updateStep(step.key, (current) => ({ ...current, waitOrdinal }));
            }} className="mt-1 block h-9 w-full border border-grit px-2 text-sm text-graphite outline-none focus:border-brass-deep" />
          </label>
        ) : null}
        {step.waitKind === "calendar_target" && step.waitTarget === "first_day_of_week_next_month" ? (
          <label className="text-sm text-stone">Day of week
            <select value={step.waitWeekday} onChange={(event) => {
              const waitWeekday = event.currentTarget.value;
              updateStep(step.key, (current) => ({ ...current, waitWeekday }));
            }} className="mt-1 block h-9 w-full border border-grit bg-white px-2 text-sm text-graphite outline-none focus:border-brass-deep"><option value="1">Monday</option><option value="2">Tuesday</option><option value="3">Wednesday</option><option value="4">Thursday</option><option value="5">Friday</option><option value="6">Saturday</option><option value="0">Sunday</option></select>
          </label>
        ) : null}
        {step.waitKind === "calendar_target" && step.waitTarget === "specific_datetime" ? (
          <label className="text-sm text-stone">Date
            <input type="date" value={step.waitDate} onChange={(event) => {
              const waitDate = event.currentTarget.value;
              updateStep(step.key, (current) => ({ ...current, waitDate }));
            }} className="mt-1 block h-9 w-full border border-grit px-2 text-sm text-graphite outline-none focus:border-brass-deep" />
          </label>
        ) : null}
        {(step.waitKind === "calendar_target") ? (
          <label className="text-sm text-stone">Time
            <input type="time" value={step.waitTime} onChange={(event) => {
              const waitTime = event.currentTarget.value;
              updateStep(step.key, (current) => ({ ...current, waitTime }));
            }} className="mt-1 block h-9 w-full border border-grit px-2 text-sm text-graphite outline-none focus:border-brass-deep" />
          </label>
        ) : null}
        {(step.waitKind !== "duration" || step.waitUnit === "calendar_days") ? (
          <label className="text-sm text-stone">IANA timezone
            <input value={step.waitTimeZone} onChange={(event) => {
              const waitTimeZone = event.currentTarget.value;
              updateStep(step.key, (current) => ({ ...current, waitTimeZone }));
            }} placeholder="America/Toronto" className="mt-1 block h-9 w-full border border-grit px-2 text-sm text-graphite outline-none focus:border-brass-deep" />
          </label>
        ) : null}
      </div>
      <p className="mt-2 text-xs text-stone">Waits resume automatically and never appear in My Work.</p>
      <FieldError message={routeError} />
    </fieldset>
  );
}

export function ConditionWaitConfigFields({
  step,
  updateStep,
  activeFields,
  currentContext,
  contextByEntityTypeId,
  routeError,
}: {
  step: LocalStep;
  updateStep: StepUpdater;
  activeFields: FieldDefinition[];
  currentContext?: ProcessTemplateEntityContext;
  contextByEntityTypeId: Map<string, ProcessTemplateEntityContext>;
  routeError?: string;
}) {
  const relationFields = activeFields.filter((field) => field.type === "relation" && field.relatedEntityTypeId);
  const targetContext = step.conditionWaitTargetKind === "related"
    ? contextByEntityTypeId.get(step.conditionWaitTargetEntityTypeId ?? "")
    : currentContext;
  const targetFields = (targetContext?.fields ?? []).filter((field) => !field.archivedAt);
  const conditions = step.conditionWaitConditions ?? [];

  return (
    <fieldset className="mt-3 border-t border-grit pt-3">
      <legend className="text-xs font-medium uppercase tracking-wide text-stone">Condition wait configuration</legend>
      <div className="mt-2 grid gap-3 md:grid-cols-2">
        <label className="text-sm text-stone">Watch
          <select value={step.conditionWaitTargetKind ?? "origin"} onChange={(event) => {
            const kind = event.currentTarget.value === "related" ? "related" : "origin";
            updateStep(step.key, (current) => ({
              ...current,
              conditionWaitTargetKind: kind,
              conditionWaitRelationFieldDefinitionId: "",
              conditionWaitTargetEntityTypeId: "",
              conditionWaitConditions: [],
            }));
          }} className="mt-1 block h-9 w-full border border-grit bg-white px-2 text-sm text-graphite outline-none focus:border-brass-deep">
            <option value="origin">The process record</option>
            <option value="related" disabled={relationFields.length === 0}>A directly related record</option>
          </select>
        </label>
        {step.conditionWaitTargetKind === "related" ? (
          <label className="text-sm text-stone">Relation
            <select value={step.conditionWaitRelationFieldDefinitionId ?? ""} onChange={(event) => {
              const relationFieldDefinitionId = event.currentTarget.value;
              const field = relationFields.find((candidate) => candidate.id === relationFieldDefinitionId);
              updateStep(step.key, (current) => ({ ...current, conditionWaitRelationFieldDefinitionId: relationFieldDefinitionId, conditionWaitTargetEntityTypeId: field?.relatedEntityTypeId ?? "", conditionWaitConditions: [] }));
            }} className="mt-1 block h-9 w-full border border-grit bg-white px-2 text-sm text-graphite outline-none focus:border-brass-deep">
              <option value="">Choose relation</option>
              {relationFields.map((field) => <option key={field.id} value={field.id}>{field.name}</option>)}
            </select>
          </label>
        ) : null}
      </div>
      <div className="mt-3 flex flex-col gap-2">
        {conditions.map((condition) => {
          const selectedField = targetFields.find((field) => field.id === condition.sourceFieldDefinitionId) ?? targetFields[0];
          const operators = selectedField ? getProcessConditionOperatorsForFieldType(selectedField.type) : [];
          const selectedOperator = operators.includes(condition.operator) ? condition.operator : operators[0] ?? "equals";
          return <div key={condition.id} className="grid gap-2 md:grid-cols-[1fr_180px_1fr_auto]">
            <select value={selectedField?.id ?? ""} onChange={(event) => { const sourceFieldDefinitionId = event.currentTarget.value; const field = targetFields.find((candidate) => candidate.id === sourceFieldDefinitionId); updateStep(step.key, (current) => ({ ...current, conditionWaitConditions: (current.conditionWaitConditions ?? []).map((candidate) => candidate.id === condition.id ? { ...candidate, sourceFieldDefinitionId, operator: field ? getProcessConditionDefaultOperator(field) : "equals", value: "" } : candidate) })); }} className="h-9 border border-grit bg-white px-2 text-sm text-graphite outline-none focus:border-brass-deep">{targetFields.map((field) => <option key={field.id} value={field.id}>{field.name}</option>)}</select>
            <select value={selectedOperator} onChange={(event) => { const operator = event.currentTarget.value as ProcessBranchConditionOperator; updateStep(step.key, (current) => ({ ...current, conditionWaitConditions: (current.conditionWaitConditions ?? []).map((candidate) => candidate.id === condition.id ? { ...candidate, operator, value: "" } : candidate) })); }} className="h-9 border border-grit bg-white px-2 text-sm text-graphite outline-none focus:border-brass-deep">{operators.map((operator) => <option key={operator} value={operator}>{processConditionOperatorLabels[operator]}</option>)}</select>
            {selectedField && processConditionOperatorNeedsValue(selectedOperator) ? <ConditionValueInput field={selectedField} value={condition.value} options={targetContext?.relationOptionsByFieldId[selectedField.id] ?? []} onChange={(value) => updateStep(step.key, (current) => ({ ...current, conditionWaitConditions: (current.conditionWaitConditions ?? []).map((candidate) => candidate.id === condition.id ? { ...candidate, value } : candidate) }))} /> : <span className="self-center text-sm text-stone">No comparison value</span>}
            <button type="button" onClick={() => updateStep(step.key, (current) => ({ ...current, conditionWaitConditions: (current.conditionWaitConditions ?? []).filter((candidate) => candidate.id !== condition.id) }))} disabled={conditions.length <= 1} className="h-9 text-xs font-medium text-stone underline-offset-4 hover:text-red-700 hover:underline disabled:cursor-not-allowed disabled:opacity-40">Remove</button>
          </div>;
        })}
        <button type="button" disabled={targetFields.length === 0} onClick={() => { const field = targetFields[0]; if (!field) return; updateStep(step.key, (current) => ({ ...current, conditionWaitConditions: [...(current.conditionWaitConditions ?? []), { id: createKey("condition"), sourceFieldDefinitionId: field.id, operator: getProcessConditionDefaultOperator(field), value: "" }] })); }} className="self-start text-sm font-medium text-stone underline-offset-4 hover:text-graphite hover:underline disabled:cursor-not-allowed disabled:opacity-40">+ Add condition</button>
      </div>
      <p className="mt-2 text-xs text-stone">Waits automatically until the current record values satisfy every condition.</p>
      <FieldError message={routeError} />
    </fieldset>
  );
}

export function AssigneeDueFields({
  step,
  index,
  members,
  updateStep,
  dueError,
}: {
  step: LocalStep;
  index: number;
  members: WorkspaceMemberIdentity[];
  updateStep: StepUpdater;
  dueError?: string;
}) {
  return (
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
        <div className="mt-1 flex flex-wrap items-center gap-2">
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
        <FieldError message={dueError} />
      </fieldset>
    </div>
  );
}

export function ApprovalOutcomesEditor({
  step,
  legalTargets,
  updateStep,
  updateRoute,
  addApprovalOutcome,
  routeError,
  highlightRouteId,
}: {
  step: LocalStep;
  legalTargets: LocalStep[];
  updateStep: StepUpdater;
  updateRoute: RouteUpdater;
  addApprovalOutcome: (stepKey: string, targetStepKey: string) => void;
  routeError?: string;
  highlightRouteId?: string | null;
}) {
  return (
    <fieldset className="mt-4 border-t border-grit pt-4">
      <legend className="text-sm font-semibold text-graphite">Outcomes</legend>
      {legalTargets.length === 0 ? (
        <p className="mt-2 text-sm text-stone">
          Add steps after this approval before configuring outcomes.
        </p>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          {step.routes.map((route, routeIndex) => (
            <HighlightableRoute
              key={route.id}
              routeId={route.id}
              highlightRouteId={highlightRouteId}
              className="grid gap-2 border border-grit bg-chalk p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
            >
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
            </HighlightableRoute>
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
  );
}

export function RoutesEditor({
  step,
  legalTargets,
  activeFields,
  currentContext,
  updateStep,
  updateRoute,
  addConditionalRoute,
  addCondition,
  routeError,
  highlightRouteId,
}: {
  step: LocalStep;
  legalTargets: LocalStep[];
  activeFields: FieldDefinition[];
  currentContext?: ProcessTemplateEntityContext;
  updateStep: StepUpdater;
  updateRoute: RouteUpdater;
  addConditionalRoute: (stepKey: string, targetStepKey: string) => void;
  addCondition: (stepKey: string, routeId: string) => void;
  routeError?: string;
  highlightRouteId?: string | null;
}) {
  const hasConditionalRoutes = step.routes.some((route) => !route.isDefault);

  if (legalTargets.length === 0) {
    return <p className="mt-4 border-t border-grit pt-3 text-sm text-stone">This is the terminal step.</p>;
  }

  return (
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
            <HighlightableRoute
              key={route.id}
              routeId={route.id}
              highlightRouteId={highlightRouteId}
              className="border border-grit bg-chalk p-3"
            >
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
            </HighlightableRoute>
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
  );
}

export type ProcessNodeEditorProps = {
  step: LocalStep;
  index: number;
  legalTargets: LocalStep[];
  activeFields: FieldDefinition[];
  currentContext?: ProcessTemplateEntityContext;
  contextByEntityTypeId: Map<string, ProcessTemplateEntityContext>;
  members: WorkspaceMemberIdentity[];
  routeError?: string;
  dueError?: string;
  updateStep: StepUpdater;
  updateRoute: RouteUpdater;
  addCondition: (stepKey: string, routeId: string) => void;
  addConditionalRoute: (stepKey: string, targetStepKey: string) => void;
  addApprovalOutcome: (stepKey: string, targetStepKey: string) => void;
  highlightRouteId?: string | null;
  processTemplates: ActionConfigProcessTemplateOption[];
};

// The single shared per-node editing body used by both the List row and the
// Graph side panel, so the two views can never drift in the fields they
// expose or how they mutate step/route state.
export function ProcessNodeEditor({
  step,
  index,
  legalTargets,
  activeFields,
  currentContext,
  contextByEntityTypeId,
  members,
  routeError,
  dueError,
  updateStep,
  updateRoute,
  addCondition,
  addConditionalRoute,
  addApprovalOutcome,
  highlightRouteId,
  processTemplates,
}: ProcessNodeEditorProps) {
  const isApproval = step.nodeType === "approval";
  const isWait = step.nodeType === "wait";
  const isConditionWait = step.nodeType === "condition_wait";
  const isAction = step.nodeType === "action";

  return (
    <>
      {isWait ? (
        <WaitConfigFields step={step} updateStep={updateStep} routeError={routeError} />
      ) : isConditionWait ? (
        <ConditionWaitConfigFields
          step={step}
          updateStep={updateStep}
          activeFields={activeFields}
          currentContext={currentContext}
          contextByEntityTypeId={contextByEntityTypeId}
          routeError={routeError}
        />
      ) : isAction ? (
        <WorkflowActionConfigFields
          idPrefix={`action-${step.key}`}
          value={step.actionConfig ?? { actionType: "update_record", fieldMappings: [] }}
          onChange={(next: WorkflowAction) => updateStep(step.key, (current) => ({ ...current, actionConfig: next }))}
          sourceFields={activeFields}
          entityContexts={Array.from(contextByEntityTypeId.values())}
          processTemplates={processTemplates}
          fieldError={routeError}
        />
      ) : (
        <AssigneeDueFields
          step={step}
          index={index}
          members={members}
          updateStep={updateStep}
          dueError={dueError}
        />
      )}

      {isApproval ? (
        <ApprovalOutcomesEditor
          step={step}
          legalTargets={legalTargets}
          updateStep={updateStep}
          updateRoute={updateRoute}
          addApprovalOutcome={addApprovalOutcome}
          routeError={routeError}
          highlightRouteId={highlightRouteId}
        />
      ) : (
        <RoutesEditor
          step={step}
          legalTargets={legalTargets}
          activeFields={activeFields}
          currentContext={currentContext}
          updateStep={updateStep}
          updateRoute={updateRoute}
          addConditionalRoute={addConditionalRoute}
          addCondition={addCondition}
          highlightRouteId={highlightRouteId}
          routeError={routeError}
        />
      )}
    </>
  );
}
