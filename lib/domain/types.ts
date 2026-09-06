// ISO 8601 UTC timestamp, for example "2026-08-14T15:30:00.000Z".
export type IsoUtcTimestamp = string;

export type Workspace = {
  id: string;
  name: string;
  createdAt: IsoUtcTimestamp;
  updatedAt: IsoUtcTimestamp;
};

export type FieldType =
  | "text"
  | "number"
  | "date"
  | "boolean"
  | "relation"
  | "choice";

export type EntityType = {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  description?: string;
  displayFieldDefinitionId?: string;
  // Phase 12.3.1/12.3.2 Quality Review metadata -- surfaced here (rather
  // than a separate lookup) since getEntityContext already selects every
  // entity_types column. Used narrowly by the Person page's Related
  // suppression (12.3.2); not a general-purpose semantic taxonomy.
  qualityReview?: boolean;
  subjectPersonFieldId?: string;
  archivedAt?: IsoUtcTimestamp;
  createdAt: IsoUtcTimestamp;
  updatedAt: IsoUtcTimestamp;
};

export type FieldDefinition = {
  id: string;
  workspaceId: string;
  entityTypeId: string;
  // Immutable record-value key; unique within a workspace.
  key: string;
  name: string;
  slug: string;
  type: FieldType;
  relatedEntityTypeId?: string;
  required: boolean;
  position: number;
  archivedAt?: IsoUtcTimestamp;
  createdAt: IsoUtcTimestamp;
  updatedAt: IsoUtcTimestamp;
};

export type FieldValue = string | number | boolean | null;

export type ChoiceOption = {
  id: string;
  workspaceId: string;
  fieldDefinitionId: FieldDefinition["id"];
  label: string;
  color?: string;
  position: number;
  archivedAt?: IsoUtcTimestamp;
  createdAt: IsoUtcTimestamp;
  updatedAt: IsoUtcTimestamp;
};

export type ChoiceOptionsByFieldId = Record<FieldDefinition["id"], ChoiceOption[]>;

export type EntityRecord = {
  id: string;
  workspaceId: string;
  entityTypeId: string;
  values: Record<FieldDefinition["key"], FieldValue>;
  archivedAt?: IsoUtcTimestamp;
  createdAt: IsoUtcTimestamp;
  updatedAt: IsoUtcTimestamp;
};
