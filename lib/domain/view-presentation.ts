import type { FieldDefinition } from "./types";
import type {
  InvalidSavedViewPresentation,
  SavedViewPresentation,
} from "./view-types";

export type PersistedViewPresentation =
  | SavedViewPresentation
  | InvalidSavedViewPresentation;

export function tablePresentation(): SavedViewPresentation {
  return { mode: "table", config: {} };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keysExactly(value: Record<string, unknown>, keys: string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();

  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function parsePersistedViewPresentation({
  mode,
  config,
}: {
  mode: unknown;
  config: unknown;
}): PersistedViewPresentation {
  if (mode === undefined || mode === null || mode === "") {
    return tablePresentation();
  }

  if (mode !== "table" && mode !== "board" && mode !== "calendar") {
    return {
      mode: "invalid",
      config: {},
      reason: "Saved view presentation mode is unknown.",
      rawMode: typeof mode === "string" ? mode : undefined,
    };
  }

  if (!isPlainObject(config)) {
    return {
      mode: "invalid",
      config: {},
      reason: "Saved view presentation config is malformed.",
      rawMode: mode,
    };
  }

  if (mode === "table") {
    return keysExactly(config, [])
      ? tablePresentation()
      : {
          mode: "invalid",
          config: {},
          reason: "Table presentation must not have mode-specific config.",
          rawMode: mode,
        };
  }

  if (mode === "board") {
    const choiceFieldDefinitionId = config.choiceFieldDefinitionId;

    return keysExactly(config, ["choiceFieldDefinitionId"]) &&
      typeof choiceFieldDefinitionId === "string" &&
      choiceFieldDefinitionId
      ? { mode, config: { choiceFieldDefinitionId } }
      : {
          mode: "invalid",
          config: {},
          reason: "Board presentation must reference one Choice field.",
          rawMode: mode,
        };
  }

  const dateFieldDefinitionId = config.dateFieldDefinitionId;

  return keysExactly(config, ["dateFieldDefinitionId"]) &&
    typeof dateFieldDefinitionId === "string" &&
    dateFieldDefinitionId
    ? { mode, config: { dateFieldDefinitionId } }
    : {
        mode: "invalid",
        config: {},
        reason: "Calendar presentation must reference one Date field.",
        rawMode: mode,
      };
}

export function validateViewPresentation({
  presentation,
  activeFields,
}: {
  presentation: SavedViewPresentation;
  activeFields: FieldDefinition[];
}): string | undefined {
  const activeFieldById = new Map(activeFields.map((field) => [field.id, field]));

  if (presentation.mode === "table") {
    return undefined;
  }

  if (presentation.mode === "board") {
    const field = activeFieldById.get(presentation.config.choiceFieldDefinitionId);

    if (!field) {
      return "Choose an active Choice field for the Board presentation.";
    }

    if (field.type !== "choice") {
      return "Board presentation requires an active Choice field.";
    }

    return undefined;
  }

  const field = activeFieldById.get(presentation.config.dateFieldDefinitionId);

  if (!field) {
    return "Choose an active Date field for the Calendar presentation.";
  }

  if (field.type !== "date") {
    return "Calendar presentation requires an active Date field.";
  }

  return undefined;
}

export function presentationReferencesField(
  presentation: PersistedViewPresentation,
  fieldDefinitionId: string,
) {
  return (
    (presentation.mode === "board" &&
      presentation.config.choiceFieldDefinitionId === fieldDefinitionId) ||
    (presentation.mode === "calendar" &&
      presentation.config.dateFieldDefinitionId === fieldDefinitionId)
  );
}
