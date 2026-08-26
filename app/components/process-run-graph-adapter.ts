import type { GraphLayoutStep } from "./process-graph-layout";
import type { ProcessRunWithSteps } from "@/lib/domain/process-types";

// Maps a run's already-snapshotted steps/routes into the same minimal
// shape the template editor's graph uses, so computeProcessGraphLayout is
// reused verbatim — no second layout algorithm. stepIndex gives the same
// "array order = topological rank" property LocalStep[] relies on, and
// parallelGroupId/route target/isDefault/isParallel already exist on the
// run's own snapshot, which is exactly why this never touches the live
// template: the run's routes are keyed by step-run id, not template node
// id, and were fixed at start time.
export function toGraphLayoutSteps(run: ProcessRunWithSteps): GraphLayoutStep[] {
  const orderedSteps = [...run.steps].sort((a, b) => a.stepIndex - b.stepIndex);

  return orderedSteps.map((step) => ({
    key: step.id,
    nodeType: step.nodeType,
    parallelGroupId: step.parallelGroupId,
    routes: run.routes
      .filter((route) => route.sourceStepRunId === step.id)
      .map((route) => ({
        id: route.id,
        targetStepKey: route.targetStepRunId,
        isDefault: route.isDefault,
        isParallel: route.isParallel,
        approvalOutcomeLabel: route.approvalOutcomeLabel,
      })),
  }));
}
