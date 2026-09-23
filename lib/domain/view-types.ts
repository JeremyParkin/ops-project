import type {
  EntityRecord,
  EntityType,
  FieldDefinition,
  FieldValue,
  IsoUtcTimestamp,
} from "./types";

export type ViewFilterOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "not_contains"
  | "greater_than"
  | "greater_than_or_equal"
  | "less_than"
  | "less_than_or_equal"
  | "before"
  | "after"
  | "is_set"
  | "is_not_set";

export type ViewSortDirection = "asc" | "desc";

export type ViewFilter = {
  fieldDefinitionId: FieldDefinition["id"];
  operator: ViewFilterOperator;
  value?: FieldValue;
};

export type ViewSort = {
  fieldDefinitionId: FieldDefinition["id"];
  direction: ViewSortDirection;
};

export type SavedViewPresentation =
  | { mode: "table"; config: Record<string, never> }
  | { mode: "board"; config: { choiceFieldDefinitionId: FieldDefinition["id"] } }
  | { mode: "calendar"; config: { dateFieldDefinitionId: FieldDefinition["id"] } };

export type InvalidSavedViewPresentation = {
  mode: "invalid";
  config: Record<string, never>;
  reason: string;
  rawMode?: string;
};

export type EntityView = {
  id: string;
  workspaceId: string;
  entityTypeId: EntityType["id"];
  name: string;
  position: number;
  isDefault: boolean;
  filters: ViewFilter[];
  sorts: ViewSort[];
  columnFieldDefinitionIds: FieldDefinition["id"][];
  presentation: SavedViewPresentation | InvalidSavedViewPresentation;
  createdAt: IsoUtcTimestamp;
  updatedAt: IsoUtcTimestamp;
};

export type EvaluatedView =
  | {
      kind: "all";
      selectedView?: undefined;
      records: EntityRecord[];
      visibleFields: FieldDefinition[];
      warnings: string[];
      invalidFilter: false;
    }
  | {
      kind: "saved";
      selectedView: EntityView;
      records: EntityRecord[];
      visibleFields: FieldDefinition[];
      warnings: string[];
      invalidFilter: boolean;
    };
