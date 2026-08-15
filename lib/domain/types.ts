// ISO 8601 UTC timestamp, for example "2026-08-14T15:30:00.000Z".
export type IsoUtcTimestamp = string;

export type Workspace = {
  id: string;
  name: string;
  createdAt: IsoUtcTimestamp;
  updatedAt: IsoUtcTimestamp;
};

export type FieldType = "text" | "number" | "date" | "boolean" | "relation";

export type EntityType = {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  description?: string;
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

export type EntityRecord = {
  id: string;
  workspaceId: string;
  entityTypeId: string;
  values: Record<FieldDefinition["key"], FieldValue>;
  archivedAt?: IsoUtcTimestamp;
  createdAt: IsoUtcTimestamp;
  updatedAt: IsoUtcTimestamp;
};
