import type { FieldType } from "./types";

export const starterOptionIds = [
  "clients",
  "projects",
  "tasks",
  "opportunities",
] as const;

export type StarterOptionId = (typeof starterOptionIds)[number];

export type WorkspaceSetupFormState = {
  success: boolean;
  message: string;
  selectedOptionIds: StarterOptionId[];
};

export const initialWorkspaceSetupFormState: WorkspaceSetupFormState = {
  success: false,
  message: "",
  selectedOptionIds: [],
};

type StarterField = {
  key: string;
  name: string;
  slug: string;
  type: FieldType;
  required?: boolean;
  relatedLocalId?: StarterOptionId;
};

export type StarterEntity = {
  localId: StarterOptionId;
  name: string;
  slug: string;
  description: string;
  fields: StarterField[];
};

export const starterOptions: Array<{
  id: StarterOptionId;
  name: string;
  description: string;
}> = [
  { id: "clients", name: "Clients", description: "People and organizations you work with." },
  { id: "projects", name: "Projects", description: "Work with status and due dates." },
  { id: "tasks", name: "Tasks", description: "Track individual pieces of work." },
  { id: "opportunities", name: "Sales / Opportunities", description: "Potential business and expected value." },
];

export function parseStarterOptionIds(values: FormDataEntryValue[]): StarterOptionId[] {
  const ids = values.filter(
    (value): value is StarterOptionId =>
      typeof value === "string" && starterOptionIds.includes(value as StarterOptionId),
  );

  return [...new Set(ids)];
}

export function buildStarterEntities(selected: StarterOptionId[]): StarterEntity[] {
  const selectedIds = new Set(selected);
  const entities: Partial<Record<StarterOptionId, StarterEntity>> = {
    clients: {
      localId: "clients",
      name: "Client",
      slug: "client",
      description: "People and organizations you work with.",
      fields: [
        { key: "client_name", name: "Name", slug: "name", type: "text", required: true },
        { key: "client_contact_name", name: "Contact name", slug: "contact-name", type: "text" },
        { key: "client_email", name: "Email", slug: "email", type: "text" },
        { key: "client_phone", name: "Phone", slug: "phone", type: "text" },
      ],
    },
    projects: {
      localId: "projects",
      name: "Project",
      slug: "project",
      description: "Projects your team is delivering.",
      fields: [
        { key: "project_name", name: "Name", slug: "name", type: "text", required: true },
        { key: "project_status", name: "Status", slug: "status", type: "text" },
        { key: "project_due_date", name: "Due date", slug: "due-date", type: "date" },
        ...(selectedIds.has("clients")
          ? [{ key: "project_client", name: "Client", slug: "client", type: "relation" as const, relatedLocalId: "clients" as const }]
          : []),
      ],
    },
    tasks: {
      localId: "tasks",
      name: "Task",
      slug: "task",
      description: "Individual pieces of work.",
      fields: [
        { key: "task_title", name: "Title", slug: "title", type: "text", required: true },
        { key: "task_status", name: "Status", slug: "status", type: "text" },
        { key: "task_due_date", name: "Due date", slug: "due-date", type: "date" },
        ...(selectedIds.has("projects")
          ? [{ key: "task_project", name: "Project", slug: "project", type: "relation" as const, relatedLocalId: "projects" as const }]
          : []),
      ],
    },
    opportunities: {
      localId: "opportunities",
      name: "Opportunity",
      slug: "opportunity",
      description: "Potential business opportunities.",
      fields: [
        { key: "opportunity_name", name: "Name", slug: "name", type: "text", required: true },
        { key: "opportunity_stage", name: "Stage", slug: "stage", type: "text" },
        { key: "opportunity_amount", name: "Amount", slug: "amount", type: "number" },
        { key: "opportunity_expected_close_date", name: "Expected close date", slug: "expected-close-date", type: "date" },
        ...(selectedIds.has("clients")
          ? [{ key: "opportunity_client", name: "Client", slug: "client", type: "relation" as const, relatedLocalId: "clients" as const }]
          : []),
      ],
    },
  };

  return starterOptionIds
    .filter((id) => selectedIds.has(id))
    .map((id) => entities[id]!);
}

export function serializeStarterEntities(entities: StarterEntity[]) {
  return entities.map((entity) => ({
    local_id: entity.localId,
    name: entity.name,
    slug: entity.slug,
    description: entity.description,
    fields: entity.fields.map((field, index) => ({
      key: field.key,
      name: field.name,
      slug: field.slug,
      type: field.type,
      required: field.required ?? false,
      position: index + 1,
      related_local_id: field.relatedLocalId ?? null,
    })),
  }));
}
