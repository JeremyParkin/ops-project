import { activeChoiceOptions, sortChoiceOptionsByPosition } from "./choice-display";
import type { ChoiceOption, EntityRecord, FieldDefinition } from "./types";

export type BoardLane =
  | {
      kind: "active";
      id: string;
      option: ChoiceOption;
      records: EntityRecord[];
    }
  | {
      kind: "unset";
      id: "unset";
      records: EntityRecord[];
    }
  | {
      kind: "archived";
      id: string;
      option: ChoiceOption;
      records: EntityRecord[];
    }
  | {
      kind: "unknown";
      id: "unknown";
      records: EntityRecord[];
    };

export function buildBoardLanes({
  field,
  options,
  records,
}: {
  field: FieldDefinition;
  options: ChoiceOption[];
  records: EntityRecord[];
}): BoardLane[] {
  const activeOptions = activeChoiceOptions(options);
  const optionById = new Map(options.map((option) => [option.id, option]));
  const activeRecordBuckets = new Map(activeOptions.map((option) => [option.id, [] as EntityRecord[]]));
  const unsetRecords: EntityRecord[] = [];
  const archivedRecordBuckets = new Map<string, EntityRecord[]>();
  const unknownRecords: EntityRecord[] = [];

  for (const record of records) {
    const value = record.values[field.key];

    if (typeof value !== "string" || value === "") {
      unsetRecords.push(record);
      continue;
    }

    const option = optionById.get(value);

    if (!option) {
      unknownRecords.push(record);
      continue;
    }

    if (option.archivedAt) {
      const bucket = archivedRecordBuckets.get(option.id) ?? [];
      bucket.push(record);
      archivedRecordBuckets.set(option.id, bucket);
      continue;
    }

    activeRecordBuckets.get(option.id)?.push(record);
  }

  const lanes: BoardLane[] = activeOptions.map((option) => ({
    kind: "active",
    id: option.id,
    option,
    records: activeRecordBuckets.get(option.id) ?? [],
  }));

  if (!field.required) {
    lanes.push({
      kind: "unset",
      id: "unset",
      records: unsetRecords,
    });
  }

  for (const option of sortChoiceOptionsByPosition(options).filter((candidate) => candidate.archivedAt)) {
    const bucket = archivedRecordBuckets.get(option.id);

    if (bucket && bucket.length > 0) {
      lanes.push({
        kind: "archived",
        id: option.id,
        option,
        records: bucket,
      });
    }
  }

  if (unknownRecords.length > 0) {
    lanes.push({
      kind: "unknown",
      id: "unknown",
      records: unknownRecords,
    });
  }

  return lanes;
}
