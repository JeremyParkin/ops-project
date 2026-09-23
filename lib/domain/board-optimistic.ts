export type OptimisticBoardCard = {
  recordId: string;
  currentValue: string;
  pending?: boolean;
  optimisticHidden?: boolean;
};

export type OptimisticBoardLane<Card extends OptimisticBoardCard> = {
  id: string;
  destinationValue?: string;
  cards: Card[];
};

export type OptimisticBoardMove<Card extends OptimisticBoardCard> = {
  recordId: string;
  sourceValue: string;
  destinationValue: string;
  card: Card;
};

export function applyOptimisticBoardMove<Card extends OptimisticBoardCard>(
  lanes: Array<OptimisticBoardLane<Card>>,
  move: OptimisticBoardMove<Card>,
): Array<OptimisticBoardLane<Card>> {
  if (
    lanes.some((lane) =>
      lane.cards.some((card) => card.recordId === move.recordId && card.pending),
    )
  ) {
    return lanes;
  }

  const destinationLaneExists = lanes.some(
    (lane) => lane.destinationValue === move.destinationValue,
  );

  if (!destinationLaneExists) {
    return lanes;
  }

  let sourceCardFound = false;

  const nextLanes = lanes.map((lane) => {
    const cards = lane.cards.map((card) => {
      if (card.recordId !== move.recordId) {
        return card;
      }

      sourceCardFound = true;

      return {
        ...card,
        optimisticHidden: true,
      };
    });

    if (lane.destinationValue !== move.destinationValue) {
      return {
        ...lane,
        cards,
      };
    }

    return {
      ...lane,
      cards: [
        ...cards,
        {
          ...move.card,
          currentValue: move.destinationValue,
          pending: true,
          optimisticHidden: false,
        },
      ],
    };
  });

  return sourceCardFound ? nextLanes : lanes;
}

export function applyOptimisticBoardMoveToLanes<
  Card extends OptimisticBoardCard,
  Lane extends OptimisticBoardLane<Card>,
>(
  lanes: Lane[],
  move: OptimisticBoardMove<Card>,
): Lane[] {
  return applyOptimisticBoardMove<Card>(lanes, move) as Lane[];
}
