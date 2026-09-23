"use client";

import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragCancelEvent,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import Link from "next/link";
import {
  createContext,
  startTransition,
  useActionState,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useOptimistic,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { RecordFieldFormState } from "@/app/actions";
import { ChoicePill } from "@/app/components/choice-pill";
import {
  applyOptimisticBoardMoveToLanes,
  type OptimisticBoardCard,
  type OptimisticBoardLane,
} from "@/lib/domain/board-optimistic";
import type { ChoiceOption } from "@/lib/domain/types";

export type MoveDestination = {
  value: string;
  label: string;
};

export type MoveAction = (
  state: RecordFieldFormState,
  formData: FormData,
) => Promise<RecordFieldFormState>;

export type BoardCardModel = OptimisticBoardCard & {
  entityTypeId: string;
  label: string;
  href: string;
  fieldKey: string;
  destinations: MoveDestination[];
  moveAction?: MoveAction;
};

export type BoardLaneModel = OptimisticBoardLane<BoardCardModel> & {
  kind: "active" | "unset" | "archived" | "unknown";
  title: string;
  option?: ChoiceOption;
};

type InitiatingInteraction = "pointer" | "move";

type RegisteredCard = {
  card: BoardCardModel;
  pending: boolean;
  dispatchMove: (destinationValue: string, initiatingInteraction: InitiatingInteraction) => void;
};

type BoardDragContextValue = {
  activeRecordId: string | null;
  overLaneValue: string | null;
  registerCard: (card: RegisteredCard) => () => void;
  requestMove: (
    recordId: string,
    destinationValue: string,
    initiatingInteraction: InitiatingInteraction,
  ) => void;
};

type DroppableLaneData = {
  destinationValue: string;
  label: string;
};

const BoardDragContext = createContext<BoardDragContextValue | null>(null);

const initialState: RecordFieldFormState = {
  success: false,
  message: "",
  value: "",
};

const unsetDestinationValue = "__unset__";
const dragIdPrefix = "board-card:";
const laneIdPrefix = "board-lane:";

function cardDragId(recordId: string) {
  return `${dragIdPrefix}${recordId}`;
}

function droppableLaneId(destinationValue: string) {
  return `${laneIdPrefix}${destinationValue || unsetDestinationValue}`;
}

function recordIdFromDragId(id: UniqueIdentifier) {
  const text = String(id);

  return text.startsWith(dragIdPrefix) ? text.slice(dragIdPrefix.length) : null;
}

function destinationFromDroppableId(id: UniqueIdentifier | null | undefined) {
  if (!id) {
    return null;
  }

  const text = String(id);
  if (!text.startsWith(laneIdPrefix)) {
    return null;
  }

  const value = text.slice(laneIdPrefix.length);

  return value === unsetDestinationValue ? "" : value;
}

function buildMoveFormData(fieldKey: string, destinationValue: string) {
  const formData = new FormData();
  formData.set("fieldKey", fieldKey);
  formData.set("value", destinationValue);

  return formData;
}

function destinationLabel(destinations: MoveDestination[], value: string) {
  return destinations.find((destination) => destination.value === value)?.label ?? "selected lane";
}

function canSubmitTo(card: RegisteredCard, destinationValue: string | null) {
  if (destinationValue === null || card.pending || card.card.pending) {
    return false;
  }

  return card.card.destinations.some((destination) => destination.value === destinationValue);
}

function visibleCards(cards: BoardCardModel[]) {
  return cards.filter((card) => !card.optimisticHidden);
}

function scrollBoardAtEdge(clientX: number, clientY: number) {
  const scrollContainer = document.querySelector<HTMLElement>("[data-board-scroll-container='true']");
  if (!scrollContainer) {
    return;
  }

  const rect = scrollContainer.getBoundingClientRect();
  const edgeSize = 64;
  if (clientY < rect.top || clientY > rect.bottom) {
    return;
  }

  if (clientX > rect.right - edgeSize) {
    scrollContainer.scrollLeft += 32;
  } else if (clientX < rect.left + edgeSize) {
    scrollContainer.scrollLeft -= 32;
  }
}

function laneTitle(lane: Pick<BoardLaneModel, "title">) {
  return lane.title;
}

export function EntityBoardDndProvider({
  entityName,
  boardFieldName,
  lanes,
}: {
  entityName: string;
  boardFieldName: string;
  lanes: BoardLaneModel[];
}) {
  const registryRef = useRef(new Map<string, RegisteredCard>());
  const pointerPositionRef = useRef<{ x: number; y: number } | null>(null);
  const dragStartPositionRef = useRef<{ x: number; y: number } | null>(null);
  const [activeRecordId, setActiveRecordId] = useState<string | null>(null);
  const [activeOverlayCard, setActiveOverlayCard] = useState<Pick<RegisteredCard["card"], "label"> | null>(null);
  const [overLaneValue, setOverLaneValue] = useState<string | null>(null);
  const [optimisticLanes, addOptimisticMove] = useOptimistic(
    lanes,
    applyOptimisticBoardMoveToLanes<BoardCardModel, BoardLaneModel>,
  );
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
  );

  const registerCard = useCallback((card: RegisteredCard) => {
    registryRef.current.set(card.card.recordId, card);

    return () => {
      const registered = registryRef.current.get(card.card.recordId);
      if (registered === card) {
        registryRef.current.delete(card.card.recordId);
      }
    };
  }, []);

  const requestMove = useCallback((
    recordId: string,
    destinationValue: string,
    initiatingInteraction: InitiatingInteraction,
  ) => {
    const registered = registryRef.current.get(recordId);
    if (!registered || !canSubmitTo(registered, destinationValue)) {
      return;
    }

    addOptimisticMove({
      recordId,
      sourceValue: registered.card.currentValue,
      destinationValue,
      card: registered.card,
    });
    registered.dispatchMove(destinationValue, initiatingInteraction);
  }, [addOptimisticMove]);

  useEffect(() => {
    const registry = registryRef.current;
    return () => {
      registry.clear();
    };
  }, []);

  useEffect(() => {
    if (!activeRecordId) {
      pointerPositionRef.current = null;
      return;
    }

    const activeId = activeRecordId;

    function handlePointerMove(event: PointerEvent) {
      pointerPositionRef.current = {
        x: event.clientX,
        y: event.clientY,
      };
      const card = registryRef.current.get(activeId);
      const element = document.elementFromPoint(event.clientX, event.clientY);
      const dropTarget = element?.closest<HTMLElement>("[data-board-drop-target='true']");
      const value = dropTarget?.dataset.boardDestinationValue;
      const destinationValue = value === unsetDestinationValue ? "" : value ?? null;
      scrollBoardAtEdge(event.clientX, event.clientY);
      setOverLaneValue(card && canSubmitTo(card, destinationValue) ? destinationValue : null);
    }

    document.addEventListener("pointermove", handlePointerMove);

    return () => {
      document.removeEventListener("pointermove", handlePointerMove);
    };
  }, [activeRecordId]);

  const destinationValueFromPointer = useCallback(() => {
    const position = pointerPositionRef.current;
    if (!position) {
      return null;
    }

    const element = document.elementFromPoint(position.x, position.y);
    const dropTarget = element?.closest<HTMLElement>("[data-board-drop-target='true']");
    if (!dropTarget) {
      return null;
    }

    const value = dropTarget.dataset.boardDestinationValue;

    return value === unsetDestinationValue ? "" : value ?? null;
  }, []);

  const finishDrag = useCallback(() => {
    setActiveRecordId(null);
    setActiveOverlayCard(null);
    setOverLaneValue(null);
    pointerPositionRef.current = null;
    dragStartPositionRef.current = null;
  }, []);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    if (event.activatorEvent instanceof PointerEvent || event.activatorEvent instanceof MouseEvent) {
      dragStartPositionRef.current = {
        x: event.activatorEvent.clientX,
        y: event.activatorEvent.clientY,
      };
    } else if (event.activatorEvent instanceof TouchEvent && event.activatorEvent.touches[0]) {
      dragStartPositionRef.current = {
        x: event.activatorEvent.touches[0].clientX,
        y: event.activatorEvent.touches[0].clientY,
      };
    }
    const recordId = recordIdFromDragId(event.active.id);
    const card = recordId ? registryRef.current.get(recordId) : undefined;
    setActiveRecordId(recordId);
    setActiveOverlayCard(card ? { label: card.card.label } : null);
    setOverLaneValue(null);
  }, []);

  const handleDragMove = useCallback((event: DragMoveEvent) => {
    const start = dragStartPositionRef.current;
    if (!start) {
      return;
    }

    const x = start.x + event.delta.x;
    const y = start.y + event.delta.y;
    pointerPositionRef.current = { x, y };
    scrollBoardAtEdge(x, y);
  }, []);

  const handleDragOver = useCallback((event: DragCancelEvent | DragEndEvent) => {
    const recordId = recordIdFromDragId(event.active.id);
    const card = recordId ? registryRef.current.get(recordId) : undefined;
    const collisionDestinationValue = destinationFromDroppableId(event.over?.id);
    const pointerDestinationValue = destinationValueFromPointer();
    const destinationValue =
      card && canSubmitTo(card, pointerDestinationValue)
        ? pointerDestinationValue
        : collisionDestinationValue;

    setOverLaneValue(card && canSubmitTo(card, destinationValue) ? destinationValue : null);
  }, [destinationValueFromPointer]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const recordId = recordIdFromDragId(event.active.id);
    const card = recordId ? registryRef.current.get(recordId) : undefined;
    const collisionDestinationValue = destinationFromDroppableId(event.over?.id);
    const pointerDestinationValue = destinationValueFromPointer();
    const destinationValue =
      card && canSubmitTo(card, pointerDestinationValue)
        ? pointerDestinationValue
        : collisionDestinationValue;

    finishDrag();

    if (!recordId || !card || destinationValue === null || !canSubmitTo(card, destinationValue)) {
      return;
    }

    startTransition(() => {
      requestMove(recordId, destinationValue, "pointer");
    });
  }, [destinationValueFromPointer, finishDrag, requestMove]);

  const handleDragCancel = useCallback(() => {
    finishDrag();
  }, [finishDrag]);

  const contextValue = useMemo(
    () => ({
      activeRecordId,
      overLaneValue,
      registerCard,
      requestMove,
    }),
    [activeRecordId, overLaneValue, registerCard, requestMove],
  );

  return (
    <BoardDragContext.Provider value={contextValue}>
      <section className="mx-auto grid w-full max-w-6xl gap-4">
        <div
          role="region"
          aria-label={`${entityName} board grouped by ${boardFieldName}`}
          tabIndex={0}
          data-board-scroll-container="true"
          className="overflow-x-auto border border-grit bg-chalk p-4"
        >
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            autoScroll={{
              enabled: true,
              threshold: {
                x: 0.18,
                y: 0.1,
              },
            }}
            onDragStart={handleDragStart}
            onDragMove={handleDragMove}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
          >
            <div className="flex min-w-max gap-4">
              {optimisticLanes.map((lane) => (
                <EntityBoardDroppableLane
                  key={`${lane.kind}-${lane.id}`}
                  labelledBy={`board-lane-${lane.kind}-${lane.id}`}
                  label={laneTitle(lane)}
                  destinationValue={lane.destinationValue}
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
                          {visibleCards(lane.cards).length} record{visibleCards(lane.cards).length === 1 ? "" : "s"}
                          {visibleCards(lane.cards).some((card) => card.pending) ? (
                            <> · {visibleCards(lane.cards).filter((card) => card.pending).length} saving</>
                          ) : null}
                        </p>
                      </div>
                      {lane.option ? <ChoicePill option={lane.option} /> : null}
                    </div>
                  </header>
                  <div className="grid gap-3 p-3">
                    {visibleCards(lane.cards).length === 0 ? (
                      <p className="border border-dashed border-grit bg-chalk px-3 py-6 text-center text-sm text-stone">
                        No records.
                      </p>
                    ) : null}
                    {lane.cards.map((card) =>
                      card.pending ? (
                        <EntityBoardPendingCard
                          key={`${card.recordId}-pending`}
                          card={card}
                        />
                      ) : (
                        <EntityBoardActionCard
                          key={`${card.recordId}-authoritative`}
                          card={card}
                        />
                      ),
                    )}
                  </div>
                </EntityBoardDroppableLane>
              ))}
            </div>
            <DragOverlay>
              {activeOverlayCard ? (
                <div
                  data-board-drag-overlay="true"
                  className="w-64 border border-border bg-surface p-3 text-sm font-medium text-foreground shadow-lg"
                  style={{ pointerEvents: "none" }}
                >
                  {activeOverlayCard.label}
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        </div>
      </section>
    </BoardDragContext.Provider>
  );
}

function EntityBoardDroppableLane({
  children,
  destinationValue,
  labelledBy,
  label,
}: {
  children: ReactNode;
  destinationValue?: string;
  labelledBy: string;
  label: string;
}) {
  const dragContext = useContext(BoardDragContext);
  const { setNodeRef, isOver } = useDroppable({
    id: droppableLaneId(destinationValue ?? ""),
    disabled: destinationValue === undefined,
    data: {
      destinationValue: destinationValue ?? "",
      label,
    } satisfies DroppableLaneData,
  });
  const highlighted = destinationValue !== undefined && dragContext?.overLaneValue === destinationValue;

  return (
    <section
      ref={destinationValue === undefined ? undefined : setNodeRef}
      aria-labelledby={labelledBy}
      data-board-drop-target={destinationValue !== undefined ? "true" : undefined}
      data-board-destination-value={
        destinationValue !== undefined ? destinationValue || unsetDestinationValue : undefined
      }
      data-board-lane={label}
      className={`w-72 shrink-0 border bg-paper transition-colors ${
        highlighted
          ? "border-brass bg-brass/10"
          : isOver && destinationValue !== undefined
            ? "border-border bg-background"
            : "border-grit"
      }`}
    >
      {children}
    </section>
  );
}

function EntityBoardPendingCard({
  card,
}: {
  card: BoardCardModel;
}) {
  return (
    <article
      className="border border-brass bg-surface p-3 shadow-sm"
      data-board-card={card.recordId}
      data-board-card-pending="true"
      data-entity-type-id={card.entityTypeId}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0 font-medium text-graphite">{card.label}</span>
      </div>
      <p className="mt-2 text-xs text-muted" aria-live="polite">
        Saving to {destinationLabel(card.destinations, card.currentValue)}...
      </p>
    </article>
  );
}

function EntityBoardActionCard({
  card,
}: {
  card: BoardCardModel;
}) {
  const dragContext = useContext(BoardDragContext);
  const [state, formAction, actionPending] = useActionState(card.moveAction ?? noopMoveAction, initialState);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const lastInitiatingInteractionRef = useRef<InitiatingInteraction | null>(null);
  const panelId = useId();
  const selectId = useId();
  const canMove = Boolean(card.moveAction && card.destinations.length > 0);
  const pending = actionPending;
  const { attributes, listeners, setActivatorNodeRef, setNodeRef, isDragging } = useDraggable({
    id: cardDragId(card.recordId),
    disabled: !canMove || pending,
    data: {
      recordId: card.recordId,
      currentValue: card.currentValue,
      label: card.label,
    },
    attributes: {
      role: "presentation",
      tabIndex: -1,
    },
  });

  const dispatchMove = useCallback((
    destinationValue: string,
    initiatingInteraction: InitiatingInteraction,
  ) => {
    if (!card.moveAction || actionPending) {
      return;
    }

    lastInitiatingInteractionRef.current = initiatingInteraction;
    formAction(buildMoveFormData(card.fieldKey, destinationValue));
  }, [actionPending, card.fieldKey, card.moveAction, formAction]);

  const submitMove = useCallback((
    destinationValue: string,
    initiatingInteraction: InitiatingInteraction,
  ) => {
    if (!dragContext || !canMove || actionPending) {
      return;
    }

    startTransition(() => {
      dragContext.requestMove(card.recordId, destinationValue, initiatingInteraction);
    });
  }, [actionPending, canMove, card.recordId, dragContext]);

  useEffect(() => {
    if (!dragContext || !canMove) {
      return;
    }

    return dragContext.registerCard({
      card,
      pending: actionPending,
      dispatchMove,
    });
  }, [actionPending, canMove, card, dispatchMove, dragContext]);

  useEffect(() => {
    if (state.message && !state.success && !actionPending) {
      if (lastInitiatingInteractionRef.current === "move") {
        triggerRef.current?.focus();
      }
    }
  }, [actionPending, state.message, state.success]);

  useEffect(() => {
    if (!open) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      if (!panelRef.current || !triggerRef.current) {
        return;
      }

      const target = event.target as Node;
      if (panelRef.current.contains(target) || triggerRef.current.contains(target)) {
        return;
      }

      if (!actionPending && !state.message) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [actionPending, open, state.message]);

  if (card.optimisticHidden) {
    return (
      <article
        ref={setNodeRef}
        hidden
        data-board-card={card.recordId}
        data-board-card-hidden="true"
      >
        {card.label}
      </article>
    );
  }

  return (
    <article
      ref={setNodeRef}
      className={`border border-grit bg-white p-3 shadow-sm transition-opacity ${
        isDragging ? "opacity-60" : ""
      }`}
      data-board-card={card.recordId}
      data-entity-type-id={card.entityTypeId}
    >
      <div className="flex items-start justify-between gap-3">
        <Link
          href={card.href}
          className="min-w-0 font-medium text-graphite underline-offset-4 hover:underline"
        >
          {card.label}
        </Link>
        {canMove ? (
          <span
            {...listeners}
            {...attributes}
            ref={setActivatorNodeRef}
            aria-hidden="true"
            tabIndex={-1}
            className="mt-0.5 inline-flex h-7 w-7 shrink-0 touch-none select-none items-center justify-center border border-border bg-surface text-muted hover:bg-background hover:text-foreground data-[pending=true]:cursor-not-allowed data-[pending=false]:cursor-grab"
            data-pending={pending}
            data-board-drag-handle={card.recordId}
            title=""
          >
            <span aria-hidden="true" className="text-base leading-none">
              ⋮⋮
            </span>
          </span>
        ) : null}
      </div>
      {canMove ? (
        <EntityBoardMoveDisclosure
          state={state}
          pending={pending}
          destinations={card.destinations}
          panelId={panelId}
          selectId={selectId}
          open={open}
          setOpen={setOpen}
          triggerRef={triggerRef}
          panelRef={panelRef}
          selectRef={selectRef}
          recordLabel={card.label}
          submitMove={(destinationValue) => submitMove(destinationValue, "move")}
        />
      ) : null}
      {state.message && !state.success && !open ? (
        <p className="mt-2 text-xs text-red-700" role="alert">
          {state.message}
        </p>
      ) : null}
      {pending ? (
        <p className="mt-2 text-xs text-muted" aria-live="polite">
          Saving to {destinationLabel(card.destinations, state.value || card.currentValue)}...
        </p>
      ) : null}
    </article>
  );
}

function EntityBoardMoveDisclosure({
  state,
  pending,
  destinations,
  panelId,
  selectId,
  open,
  setOpen,
  triggerRef,
  panelRef,
  selectRef,
  recordLabel,
  submitMove,
}: {
  state: RecordFieldFormState;
  pending: boolean;
  destinations: MoveDestination[];
  panelId: string;
  selectId: string;
  open: boolean;
  setOpen: (open: boolean) => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
  panelRef: RefObject<HTMLDivElement | null>;
  selectRef: RefObject<HTMLSelectElement | null>;
  recordLabel: string;
  submitMove: (destinationValue: string) => void;
}) {
  const [selectedValue, setSelectedValue] = useState("");
  const submittedValue = selectedValue === unsetDestinationValue ? "" : selectedValue;

  return (
    <div className="relative mt-3">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Move ${recordLabel}`}
        disabled={pending}
        onClick={() => setOpen(!open)}
        className="inline-flex h-8 items-center justify-center border border-border bg-surface px-2.5 text-xs font-medium text-muted hover:bg-background hover:text-foreground focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-foreground disabled:cursor-not-allowed disabled:bg-background disabled:text-muted"
      >
        {pending ? "Saving..." : "Move"}
      </button>
      {open ? (
        <div
          ref={panelRef}
          id={panelId}
          role="group"
          aria-label={`Move ${recordLabel}`}
          className="absolute left-0 z-20 mt-2 w-64 border border-border bg-surface p-3 shadow-lg"
        >
          <form
            className="grid gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              submitMove(submittedValue);
            }}
          >
            <label htmlFor={selectId} className="text-xs font-medium text-muted">
              Move to
            </label>
            <select
              ref={selectRef}
              id={selectId}
              value={selectedValue}
              onChange={(event) => setSelectedValue(event.target.value)}
              disabled={pending}
              className="h-9 min-w-0 border border-border bg-surface px-2 text-sm text-foreground focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-foreground disabled:cursor-not-allowed disabled:bg-background disabled:text-muted"
            >
              <option value="" disabled>
                Choose lane
              </option>
              {destinations.map((destination) => (
                <option
                  key={destination.value || unsetDestinationValue}
                  value={destination.value || unsetDestinationValue}
                >
                  {destination.label}
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={pending || selectedValue === ""}
              className="inline-flex h-9 items-center justify-center border border-border bg-surface px-3 text-sm font-medium text-muted hover:bg-background hover:text-foreground focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-foreground disabled:cursor-not-allowed disabled:bg-background disabled:text-muted"
            >
              {pending ? "Saving..." : "Confirm move"}
            </button>
          </form>
          {state.message && !state.success ? (
            <p className="mt-2 text-xs text-red-700" role="alert">
              {state.message}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

async function noopMoveAction(
  state: RecordFieldFormState,
  formData: FormData,
): Promise<RecordFieldFormState> {
  void state;
  void formData;

  return {
    success: false,
    message: "This record can't be moved.",
    value: "",
  };
}
