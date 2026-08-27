import {
  listAssignedWorkItems,
  type MyWorkItem,
} from "@/lib/domain/process-repository";
import {
  listManagedPeopleContext,
  type ManagedPersonContext,
} from "@/lib/domain/workspace-organization-repository";

export type ManagedWorkFilter =
  | { kind: "all" }
  | { kind: "direct" }
  | { kind: "team"; teamId: string }
  | { kind: "person"; userId: string };

export type ManagedWorkItem = MyWorkItem & {
  person: ManagedPersonContext;
};

export type ManagedWorkPortfolio = {
  people: ManagedPersonContext[];
  selectedPeople: ManagedPersonContext[];
  overdue: ManagedWorkItem[];
  readyNow: ManagedWorkItem[];
  upcoming: ManagedWorkItem[];
};

export function resolveManagedWorkFilter({
  people,
  scope,
  id,
  person,
}: {
  people: ManagedPersonContext[];
  scope?: string;
  id?: string;
  person?: string;
}): ManagedWorkFilter | undefined {
  if (person && people.some((candidate) => candidate.userId === person)) {
    return { kind: "person", userId: person };
  }

  if (person) {
    return undefined;
  }

  if (!scope || scope === "all") {
    return { kind: "all" };
  }

  if (scope === "direct" && !id) {
    return { kind: "direct" };
  }

  if (
    scope === "team" &&
    id &&
    people.some((candidate) => candidate.teamSources.some((team) => team.teamId === id))
  ) {
    return { kind: "team", teamId: id };
  }

  return undefined;
}

function peopleForFilter({
  people,
  filter,
}: {
  people: ManagedPersonContext[];
  filter: ManagedWorkFilter;
}) {
  switch (filter.kind) {
    case "direct":
      return people.filter((person) => person.isDirectReport);
    case "team":
      return people.filter((person) =>
        person.teamSources.some((team) => team.teamId === filter.teamId),
      );
    case "person":
      return people.filter((person) => person.userId === filter.userId);
    case "all":
      return people;
  }
}

function attachPeople({
  items,
  peopleById,
}: {
  items: MyWorkItem[];
  peopleById: Map<string, ManagedPersonContext>;
}): ManagedWorkItem[] {
  return items.flatMap((item) => {
    const person = item.stepRun.assigneeUserId
      ? peopleById.get(item.stepRun.assigneeUserId)
      : undefined;

    return person ? [{ ...item, person }] : [];
  });
}

// Scope is always derived by the authorized organization RPC. The filter is
// only applied to that returned set, so query parameters cannot expand it.
export async function getManagedWorkPortfolio({
  workspaceId,
  people,
  filter,
}: {
  workspaceId: string;
  people: ManagedPersonContext[];
  filter: ManagedWorkFilter;
}): Promise<ManagedWorkPortfolio> {
  const selectedPeople = peopleForFilter({ people, filter });
  const summary = await listAssignedWorkItems({
    workspaceId,
    assigneeUserIds: selectedPeople.map((person) => person.userId),
  });
  const peopleById = new Map(selectedPeople.map((person) => [person.userId, person]));

  return {
    people,
    selectedPeople,
    overdue: attachPeople({ items: summary.overdue, peopleById }),
    readyNow: attachPeople({ items: summary.readyNow, peopleById }),
    upcoming: attachPeople({ items: summary.upcoming, peopleById }),
  };
}

export async function getManagedPeopleContext({
  workspaceId,
}: {
  workspaceId: string;
}) {
  return listManagedPeopleContext({ workspaceId });
}
