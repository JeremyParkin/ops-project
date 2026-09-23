import Link from "next/link";
import { updateRecordField } from "@/app/actions";
import { ChoicePill } from "@/app/components/choice-pill";
import {
  EntityBoardCard,
  EntityBoardDndProvider,
  EntityBoardDroppableLane,
} from "@/app/components/entity-board-dnd";
import { buildBoardLanes } from "@/lib/domain/board-view";
import { activeChoiceOptions } from "@/lib/domain/choice-display";
import { getRecordLabel } from "@/lib/domain/record-repository";
import type { ChoiceOption, EntityRecord, EntityType, FieldDefinition } from "@/lib/domain/types";
import type { TableEmptyState } from "@/lib/domain/table-empty-state";

type EntityBoardViewProps = {
  entityType: EntityType;
  fields: FieldDefinition[];
  records: EntityRecord[];
  boardField: FieldDefinition;
  choiceOptions: ChoiceOption[];
  recordActionContext?: {
    workspaceId: string;
    entityTypeId: string;
  };
  emptyState?: TableEmptyState;
};

function laneTitle(lane: ReturnType<typeof buildBoardLanes>[number]) {
  if (lane.kind === "active" || lane.kind === "archived") {
    return lane.option.label;
  }

  if (lane.kind === "unset") {
    return "Unset";
  }

  return "Unknown option";
}

function moveDestinations({
  field,
  activeOptions,
  currentValue,
}: {
  field: FieldDefinition;
  activeOptions: ChoiceOption[];
  currentValue: unknown;
}) {
  const destinations = activeOptions
    .filter((option) => option.id !== currentValue)
    .map((option) => ({
      value: option.id,
      label: option.label,
    }));

  if (!field.required && currentValue !== null && currentValue !== undefined && currentValue !== "") {
    destinations.push({ value: "", label: "Unset" });
  }

  return destinations;
}

function EmptyBoardNotice({
  entityType,
  emptyState,
}: {
  entityType: EntityType;
  emptyState: TableEmptyState;
}) {
  return (
    <section className="border border-dashed border-grit bg-chalk px-5 py-6 text-center">
      <h2 className="text-lg font-semibold text-graphite">{emptyState.title}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-stone">
        {emptyState.description}
      </p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
        {emptyState.action ? (
          <Link
            href={emptyState.action.href}
            className="inline-flex h-10 items-center justify-center bg-brass px-4 text-sm font-medium text-graphite hover:bg-brass-deep hover:text-paper"
          >
            {emptyState.action.label}
          </Link>
        ) : null}
        <Link
          href="#add-record"
          className={
            emptyState.action
              ? "inline-flex h-10 items-center justify-center border border-grit px-4 text-sm font-medium text-stone hover:bg-slab/5"
              : "inline-flex h-10 items-center justify-center bg-brass px-4 text-sm font-medium text-graphite hover:bg-brass-deep hover:text-paper"
          }
        >
          Add {entityType.name}
        </Link>
        <Link
          href={`/entities/${entityType.id}/import`}
          className="inline-flex h-10 items-center justify-center border border-grit px-4 text-sm font-medium text-stone hover:bg-slab/5"
        >
          Import CSV
        </Link>
      </div>
    </section>
  );
}

export function EntityBoardView({
  entityType,
  fields,
  records,
  boardField,
  choiceOptions,
  recordActionContext,
  emptyState,
}: EntityBoardViewProps) {
  const lanes = buildBoardLanes({
    field: boardField,
    options: choiceOptions,
    records,
  });
  const activeOptions = activeChoiceOptions(choiceOptions);

  return (
    <section className="mx-auto grid w-full max-w-6xl gap-4">
      {records.length === 0 && emptyState ? (
        <EmptyBoardNotice entityType={entityType} emptyState={emptyState} />
      ) : null}
      <div
        role="region"
        aria-label={`${entityType.name} board grouped by ${boardField.name}`}
        tabIndex={0}
        data-board-scroll-container="true"
        className="overflow-x-auto border border-grit bg-chalk p-4"
      >
        <EntityBoardDndProvider>
          <div className="flex min-w-max gap-4">
            {lanes.map((lane) => (
              <EntityBoardDroppableLane
                key={`${lane.kind}-${lane.id}`}
                labelledBy={`board-lane-${lane.kind}-${lane.id}`}
                label={laneTitle(lane)}
                destinationValue={
                  lane.kind === "active" ? lane.option.id : lane.kind === "unset" ? "" : undefined
                }
              >
                <header className="border-b border-grit bg-white px-3 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2
                        id={`board-lane-${lane.kind}-${lane.id}`}
                        className="text-sm font-semibold text-graphite"
                      >
                        {laneTitle(lane)}
                        {lane.kind === "archived" ? (
                          <span className="ml-1 text-xs font-medium text-stone">(Archived option)</span>
                        ) : null}
                      </h2>
                      <p className="mt-1 text-xs text-stone">
                        {lane.records.length} record{lane.records.length === 1 ? "" : "s"}
                      </p>
                    </div>
                    {lane.kind === "active" || lane.kind === "archived" ? (
                      <ChoicePill option={lane.option} />
                    ) : null}
                  </div>
                </header>
                <div className="grid gap-3 p-3">
                  {lane.records.length === 0 ? (
                    <p className="border border-dashed border-grit bg-chalk px-3 py-6 text-center text-sm text-stone">
                      No records.
                    </p>
                  ) : null}
                  {lane.records.map((record) => {
                    const actionContext = recordActionContext
                      ? {
                          ...recordActionContext,
                          recordId: record.id,
                        }
                      : undefined;
                    const currentValue = record.values[boardField.key];
                    const destinations = moveDestinations({
                      field: boardField,
                      activeOptions,
                      currentValue,
                    });
                    const moveAction = actionContext
                      ? updateRecordField.bind(null, actionContext)
                      : undefined;
                    const label = getRecordLabel({ entityType, fields, record });

                    return (
                      <EntityBoardCard
                        key={record.id}
                        entityTypeId={entityType.id}
                        recordId={record.id}
                        label={label}
                        href={`/entities/${entityType.id}/records/${record.id}`}
                        fieldKey={boardField.key}
                        currentValue={currentValue}
                        destinations={destinations}
                        moveAction={moveAction}
                      />
                    );
                  })}
                </div>
              </EntityBoardDroppableLane>
            ))}
          </div>
        </EntityBoardDndProvider>
      </div>
    </section>
  );
}
