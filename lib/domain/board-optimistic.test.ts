import { describe, expect, it } from "vitest";
import { applyOptimisticBoardMove, type OptimisticBoardLane } from "./board-optimistic";

type TestCard = {
  recordId: string;
  currentValue: string;
  label: string;
  pending?: boolean;
  optimisticHidden?: boolean;
};

function card(recordId: string, currentValue: string): TestCard {
  return {
    recordId,
    currentValue,
    label: recordId,
  };
}

function lanes(): Array<OptimisticBoardLane<TestCard>> {
  return [
    {
      id: "todo",
      destinationValue: "todo",
      cards: [card("a", "todo"), card("b", "todo")],
    },
    {
      id: "done",
      destinationValue: "done",
      cards: [card("c", "done")],
    },
    {
      id: "unset",
      destinationValue: "",
      cards: [card("d", "")],
    },
    {
      id: "archived",
      cards: [card("e", "archived")],
    },
  ];
}

function visibleRecordIds(lane: OptimisticBoardLane<TestCard>) {
  return lane.cards
    .filter((row) => !row.optimisticHidden)
    .map((row) => row.recordId);
}

describe("applyOptimisticBoardMove", () => {
  it("begins a move by suppressing the source card and inserting a pending destination card", () => {
    const result = applyOptimisticBoardMove(lanes(), {
      recordId: "a",
      sourceValue: "todo",
      destinationValue: "done",
      card: card("a", "todo"),
    });

    expect(visibleRecordIds(result[0])).toEqual(["b"]);
    expect(result[0].cards.find((row) => row.recordId === "a")).toMatchObject({
      optimisticHidden: true,
    });
    expect(visibleRecordIds(result[1])).toEqual(["c", "a"]);
    expect(result[1].cards.at(-1)).toMatchObject({
      recordId: "a",
      currentValue: "done",
      pending: true,
    });
  });

  it("never duplicates the moved card", () => {
    const result = applyOptimisticBoardMove(lanes(), {
      recordId: "a",
      sourceValue: "todo",
      destinationValue: "done",
      card: card("a", "todo"),
    });

    expect(
      result
        .flatMap((lane) => lane.cards)
        .filter((row) => row.recordId === "a" && !row.optimisticHidden),
    ).toHaveLength(1);
  });

  it("supports Unset as a destination", () => {
    const result = applyOptimisticBoardMove(lanes(), {
      recordId: "a",
      sourceValue: "todo",
      destinationValue: "",
      card: card("a", "todo"),
    });

    expect(visibleRecordIds(result[2])).toEqual(["d", "a"]);
    expect(result[2].cards.at(-1)).toMatchObject({ currentValue: "", pending: true });
  });

  it("moves records out of archived source lanes without making archived lanes destinations", () => {
    const result = applyOptimisticBoardMove(lanes(), {
      recordId: "e",
      sourceValue: "archived",
      destinationValue: "todo",
      card: card("e", "archived"),
    });

    expect(visibleRecordIds(result[3])).toEqual([]);
    expect(visibleRecordIds(result[0])).toEqual(["a", "b", "e"]);
  });

  it("supports simultaneous moves for different records", () => {
    const first = applyOptimisticBoardMove(lanes(), {
      recordId: "a",
      sourceValue: "todo",
      destinationValue: "done",
      card: card("a", "todo"),
    });
    const second = applyOptimisticBoardMove(first, {
      recordId: "b",
      sourceValue: "todo",
      destinationValue: "",
      card: card("b", "todo"),
    });

    expect(visibleRecordIds(second[0])).toEqual([]);
    expect(visibleRecordIds(second[1])).toEqual(["c", "a"]);
    expect(visibleRecordIds(second[2])).toEqual(["d", "b"]);
  });

  it("rejects duplicate pending moves for the same record", () => {
    const first = applyOptimisticBoardMove(lanes(), {
      recordId: "a",
      sourceValue: "todo",
      destinationValue: "done",
      card: card("a", "todo"),
    });
    const second = applyOptimisticBoardMove(first, {
      recordId: "a",
      sourceValue: "done",
      destinationValue: "",
      card: card("a", "done"),
    });

    expect(second).toBe(first);
  });

  it("ignores moves to non-destination lanes", () => {
    const current = lanes();
    const result = applyOptimisticBoardMove(current, {
      recordId: "a",
      sourceValue: "todo",
      destinationValue: "archived",
      card: card("a", "todo"),
    });

    expect(result).toBe(current);
  });

  it("authoritative replacement after success or failure is just the next server lane model", () => {
    const authoritative = lanes();
    const optimistic = applyOptimisticBoardMove(authoritative, {
      recordId: "a",
      sourceValue: "todo",
      destinationValue: "done",
      card: card("a", "todo"),
    });

    expect(optimistic).not.toBe(authoritative);
    expect(authoritative[0].cards.map((row) => row.recordId)).toEqual(["a", "b"]);
    expect(authoritative[1].cards.map((row) => row.recordId)).toEqual(["c"]);
  });
});
