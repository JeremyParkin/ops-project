import { describe, expect, it } from "vitest";
import type { FieldDefinition } from "./types";
import { mapEntityView } from "./view-repository";
import { validateViewFormData } from "./view-validation";
import {
  parsePersistedViewPresentation,
  presentationReferencesField,
  validateViewPresentation,
} from "./view-presentation";

function field(overrides: Partial<FieldDefinition> & Pick<FieldDefinition, "id" | "key" | "name" | "type">): FieldDefinition {
  return {
    workspaceId: "workspace-1",
    entityTypeId: "entity-1",
    slug: overrides.key,
    required: false,
    position: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const titleField = field({ id: "field-title", key: "title", name: "Title", type: "text", position: 0 });
const statusField = field({ id: "field-status", key: "status", name: "Status", type: "choice", position: 1 });
const dueField = field({ id: "field-due", key: "due", name: "Due", type: "date", position: 2 });
const archivedStatusField = { ...statusField, archivedAt: "2026-02-01T00:00:00.000Z" };

function baseFormData() {
  const formData = new FormData();
  formData.set("viewName", "Important work");
  formData.append("columnFieldDefinitionId", titleField.id);
  formData.set("presentationMode", "table");
  return formData;
}

async function validate(formData: FormData, activeFields: FieldDefinition[] = [titleField, statusField, dueField]) {
  return validateViewFormData({
    activeFields,
    allFields: [titleField, archivedStatusField, dueField],
    formData,
    validateRelationValue: async () => true,
    validateChoiceValue: async () => true,
    validateWorkspaceMemberValue: async () => true,
  });
}

describe("parsePersistedViewPresentation", () => {
  it("accepts exact table, board, and calendar configs", () => {
    expect(parsePersistedViewPresentation({ mode: "table", config: {} })).toEqual({
      mode: "table",
      config: {},
    });
    expect(parsePersistedViewPresentation({
      mode: "board",
      config: { choiceFieldDefinitionId: statusField.id },
    })).toEqual({
      mode: "board",
      config: { choiceFieldDefinitionId: statusField.id },
    });
    expect(parsePersistedViewPresentation({
      mode: "calendar",
      config: { dateFieldDefinitionId: dueField.id },
    })).toEqual({
      mode: "calendar",
      config: { dateFieldDefinitionId: dueField.id },
    });
  });

  it("treats missing persisted columns as table compatibility", () => {
    expect(parsePersistedViewPresentation({ mode: undefined, config: undefined })).toEqual({
      mode: "table",
      config: {},
    });
  });

  it("fails safely for unknown, malformed, or extra-key configs", () => {
    expect(parsePersistedViewPresentation({ mode: "gallery", config: {} }).mode).toBe("invalid");
    expect(parsePersistedViewPresentation({ mode: "board", config: [] }).mode).toBe("invalid");
    expect(parsePersistedViewPresentation({
      mode: "board",
      config: { choiceFieldDefinitionId: statusField.id, extra: true },
    }).mode).toBe("invalid");
    expect(parsePersistedViewPresentation({
      mode: "calendar",
      config: { choiceFieldDefinitionId: statusField.id },
    }).mode).toBe("invalid");
  });
});

describe("validateViewPresentation", () => {
  it("requires a Choice field for board and a Date field for calendar", () => {
    expect(validateViewPresentation({
      presentation: { mode: "board", config: { choiceFieldDefinitionId: statusField.id } },
      activeFields: [titleField, statusField, dueField],
    })).toBeUndefined();
    expect(validateViewPresentation({
      presentation: { mode: "calendar", config: { dateFieldDefinitionId: dueField.id } },
      activeFields: [titleField, statusField, dueField],
    })).toBeUndefined();
    expect(validateViewPresentation({
      presentation: { mode: "board", config: { choiceFieldDefinitionId: titleField.id } },
      activeFields: [titleField, statusField, dueField],
    })).toMatch(/Choice/);
    expect(validateViewPresentation({
      presentation: { mode: "calendar", config: { dateFieldDefinitionId: statusField.id } },
      activeFields: [titleField, statusField, dueField],
    })).toMatch(/Date/);
  });

  it("rejects archived or missing configured fields", () => {
    expect(validateViewPresentation({
      presentation: { mode: "board", config: { choiceFieldDefinitionId: statusField.id } },
      activeFields: [titleField, dueField],
    })).toMatch(/active Choice/);
  });
});

describe("validateViewFormData presentation fields", () => {
  it("defaults existing table submissions to table presentation", async () => {
    const formData = baseFormData();
    formData.delete("presentationMode");

    const result = await validate(formData);

    expect(result.success).toBe(true);
    expect(result.values.presentation).toEqual({ mode: "table", config: {} });
  });

  it("accepts valid board and calendar presentation submissions", async () => {
    const board = baseFormData();
    board.set("presentationMode", "board");
    board.set("boardChoiceFieldDefinitionId", statusField.id);
    expect((await validate(board)).values.presentation).toEqual({
      mode: "board",
      config: { choiceFieldDefinitionId: statusField.id },
    });

    const calendar = baseFormData();
    calendar.set("presentationMode", "calendar");
    calendar.set("calendarDateFieldDefinitionId", dueField.id);
    expect((await validate(calendar)).values.presentation).toEqual({
      mode: "calendar",
      config: { dateFieldDefinitionId: dueField.id },
    });
  });

  it("rejects unknown modes and incompatible fields", async () => {
    const unknown = baseFormData();
    unknown.set("presentationMode", "gallery");
    expect(await validate(unknown)).toMatchObject({
      success: false,
      errors: { presentationMode: "Choose Table, Board, or Calendar." },
    });

    const wrongField = baseFormData();
    wrongField.set("presentationMode", "board");
    wrongField.set("boardChoiceFieldDefinitionId", dueField.id);
    expect(await validate(wrongField)).toMatchObject({
      success: false,
      errors: { presentationConfig: "Board presentation requires an active Choice field." },
    });
  });
});

describe("EntityView repository mapping", () => {
  it("maps persisted presentation columns and field references", () => {
    const view = mapEntityView({
      id: "view-1",
      workspace_id: "workspace-1",
      entity_type_id: "entity-1",
      name: "Board",
      position: 1,
      is_default: false,
      filters: [],
      sorts: [],
      column_field_definition_ids: [titleField.id],
      presentation_mode: "board",
      presentation_config: { choiceFieldDefinitionId: statusField.id },
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });

    expect(view.presentation).toEqual({
      mode: "board",
      config: { choiceFieldDefinitionId: statusField.id },
    });
    expect(presentationReferencesField(view.presentation, statusField.id)).toBe(true);
  });
});
