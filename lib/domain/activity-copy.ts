import type { RecordActivityEvent } from "./activity-types";

export type ActivityCopy = {
  title: string;
  /** Short secondary text (e.g. "Scheduled") -- omitted when there's nothing useful to add. */
  meta?: string;
  href?: string;
};

function processRunHref(processRunId?: string) {
  return processRunId ? `/process-runs/${processRunId}` : undefined;
}

function displayValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "empty";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return JSON.stringify(value);
}

function recordAttribution(event: RecordActivityEvent) {
  return event.authorityKind === "impersonated" && event.realActorLabel
    ? `${event.actorLabel ?? "Effective user"} (by ${event.realActorLabel})`
    : event.actorLabel;
}

function changeDetail(name: string, oldValue: unknown, newValue: unknown) {
  const hadOldValue = oldValue !== null && oldValue !== undefined && oldValue !== "";
  const hasNewValue = newValue !== null && newValue !== undefined && newValue !== "";
  if (!hadOldValue && hasNewValue) return `${name} set to ${displayValue(newValue)}`;
  if (hadOldValue && !hasNewValue) return `${name} cleared`;
  return `${name} changed from ${displayValue(oldValue)} to ${displayValue(newValue)}`;
}

// Pure event -> human copy. Operational language only, no implementation
// vocabulary (no "step run", "node", "RPC", IDs) -- see Phase 8D.3 scope.
// actorLabel/actorUserId being absent IS the "system-triggered" signal for
// process_started (see the migration's actor-semantics design); there is no
// separate "trigger source" field to branch on.
export function formatActivityEvent(event: RecordActivityEvent): ActivityCopy {
  const runName = event.processRunName ?? "Process";

  if (event.eventType === "record_created") {
    return { title: "Record created", meta: recordAttribution(event) };
  }
  if (event.eventType === "record_archived") return { title: "Record archived", meta: recordAttribution(event) };
  if (event.eventType === "record_restored") return { title: "Record restored", meta: recordAttribution(event) };
  if (event.eventType === "record_updated") {
    const changes = event.changes;
    const fields = changes?.fields ?? [];
    const relations = changes?.relations ?? [];
    const total = fields.length + relations.length;
    const detail = total === 1
      ? fields.length === 1
        ? changeDetail(
          fields[0].field_name_snapshot ?? "Field",
          fields[0].old_choice_label_snapshot ?? fields[0].old_value,
          fields[0].new_choice_label_snapshot ?? fields[0].new_value,
        )
        : changeDetail(
          relations[0].field_name_snapshot ?? "Relation",
          relations[0].old_target_label_snapshot,
          relations[0].new_target_label_snapshot,
        )
      : `${total} fields changed`;
    return { title: detail, meta: recordAttribution(event) };
  }

  switch (event.eventType) {
    case "process_started": {
      const isAutomatic = !event.actorUserId;
      return {
        title: isAutomatic ? `${runName} started automatically` : `${runName} started`,
        meta: event.isRecurrenceStarted ? "Scheduled" : undefined,
        href: processRunHref(event.processRunId),
      };
    }
    case "process_completed":
      return {
        title: `${runName} completed`,
        href: processRunHref(event.processRunId),
      };
    case "step_assigned": {
      const stepName = event.stepName ?? "a step";
      return {
        title: event.assigneeLabel
          ? `${event.assigneeLabel} was assigned ${stepName}`
          : `${stepName} was assigned`,
        href: processRunHref(event.processRunId),
      };
    }
    case "approval_decided": {
      const stepName = event.stepName ?? "Approval";
      const outcome = event.approvalOutcomeLabel?.toLowerCase();
      const decidedBy = event.actorLabel ? ` by ${event.actorLabel}` : "";
      return {
        title: outcome ? `${stepName} ${outcome}${decidedBy}` : `${stepName} decided${decidedBy}`,
        href: processRunHref(event.processRunId),
      };
    }
    case "process_cancelled": {
      const cancelledBy = event.actorLabel ? ` by ${event.actorLabel}` : "";
      return {
        title: `${runName} cancelled${cancelledBy}`,
        meta: event.cancellationReason,
        href: processRunHref(event.processRunId),
      };
    }
    case "step_reassigned": {
      const stepName = event.stepName ?? "a step";
      const from = event.fromAssigneeLabel;
      const to = event.toAssigneeLabel ?? "someone else";
      // 11.3: an administrative reassignment has a third-party actor --
      // someone other than the outgoing assignee performed it. Comparing
      // by label (not a from_assignee_user_id ID, which this read model
      // doesn't carry -- see the Phase 11.3 plan) is the established
      // stable-enough identity this app already uses for member display
      // everywhere else. Self-reassignment (actor === from) says nothing
      // extra, exactly as before this phase.
      const isAdministrative = Boolean(event.actorLabel && from && event.actorLabel !== from);
      const by = isAdministrative ? ` by ${event.actorLabel}` : "";
      return {
        title: from
          ? `${stepName} reassigned from ${from} to ${to}${by}`
          : `${stepName} reassigned to ${to}${by}`,
        href: processRunHref(event.processRunId),
      };
    }
    case "quality_review_finalized": {
      const by = event.actorLabel ? ` by ${event.actorLabel}` : "";
      return { title: `Finalized${by}` };
    }
    case "quality_review_reopened": {
      const by = event.actorLabel ? ` by ${event.actorLabel}` : "";
      return { title: `Reopened for correction${by}` };
    }
    default:
      return { title: "Activity", href: processRunHref(event.processRunId) };
  }
}
