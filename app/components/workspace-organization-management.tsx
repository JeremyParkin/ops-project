"use client";

import { useActionState } from "react";
import {
  createWorkspaceTeamAction,
  deleteWorkspaceTeamAction,
  setWorkspacePrimaryManagerAction,
  setWorkspaceTeamArchivedAction,
  setWorkspaceTeamLeadAction,
  setWorkspaceTeamMembershipAction,
  updateWorkspaceTeamAction,
  type WorkspaceOrganizationActionState,
} from "@/app/workspace-organization-actions";
import type {
  WorkspaceOrganizationMember,
  WorkspaceTeam,
  WorkspaceTeamMembership,
} from "@/lib/domain/workspace-organization-repository";

const initialState: WorkspaceOrganizationActionState = {
  success: false,
  message: "",
};

function ActionMessage({ state }: { state: WorkspaceOrganizationActionState }) {
  return state.message ? (
    <p className={`mt-2 text-sm ${state.success ? "text-status-sage" : "text-red-700"}`} role="status">
      {state.message}
    </p>
  ) : null;
}

function TeamMemberRow({
  team,
  member,
  membership,
}: {
  team: WorkspaceTeam;
  member: WorkspaceOrganizationMember;
  membership: WorkspaceTeamMembership;
}) {
  const [membershipState, membershipAction, membershipPending] = useActionState(
    setWorkspaceTeamMembershipAction,
    initialState,
  );
  const [leadState, leadAction, leadPending] = useActionState(
    setWorkspaceTeamLeadAction,
    initialState,
  );

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 border-t border-grit py-3 first:border-t-0">
      <div>
        <p className="text-sm font-medium text-graphite">{member.email}</p>
        <p className="text-xs text-stone">{membership.isLead ? "Team lead" : "Team member"}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <form action={leadAction}>
          <input type="hidden" name="teamId" value={team.id} />
          <input type="hidden" name="userId" value={member.userId} />
          <input type="hidden" name="isLead" value={String(!membership.isLead)} />
          <button
            type="submit"
            disabled={leadPending}
            className="text-sm font-medium text-graphite underline-offset-4 hover:underline disabled:text-stone"
          >
            {leadPending ? "Saving..." : membership.isLead ? "Remove lead" : "Make lead"}
          </button>
        </form>
        <form action={membershipAction}>
          <input type="hidden" name="teamId" value={team.id} />
          <input type="hidden" name="userId" value={member.userId} />
          <input type="hidden" name="isMember" value="false" />
          <button
            type="submit"
            disabled={membershipPending}
            className="text-sm font-medium text-red-700 underline-offset-4 hover:underline disabled:text-red-300"
          >
            {membershipPending ? "Removing..." : "Remove"}
          </button>
        </form>
      </div>
      <div className="basis-full">
        <ActionMessage state={leadState} />
        <ActionMessage state={membershipState} />
      </div>
    </li>
  );
}

function TeamEditor({
  team,
  members,
  memberships,
}: {
  team: WorkspaceTeam;
  members: WorkspaceOrganizationMember[];
  memberships: WorkspaceTeamMembership[];
}) {
  const [updateState, updateAction, updatePending] = useActionState(updateWorkspaceTeamAction, initialState);
  const [archiveState, archiveAction, archivePending] = useActionState(setWorkspaceTeamArchivedAction, initialState);
  const [deleteState, deleteAction, deletePending] = useActionState(deleteWorkspaceTeamAction, initialState);
  const [addState, addAction, addPending] = useActionState(setWorkspaceTeamMembershipAction, initialState);
  const membersById = new Map(members.map((member) => [member.userId, member]));
  const teamMemberships = memberships.filter((membership) => membership.teamId === team.id);
  const availableMembers = members.filter(
    (member) => !teamMemberships.some((membership) => membership.userId === member.userId),
  );
  const isArchived = Boolean(team.archivedAt);

  return (
    <article className="border border-grit bg-paper p-4">
      <form action={updateAction} className="grid gap-3">
        <input type="hidden" name="teamId" value={team.id} />
        <div className="flex flex-wrap items-start justify-between gap-3">
          <label className="min-w-0 flex-1 text-sm font-medium text-graphite" htmlFor={`team-name-${team.id}`}>
            Team name
            <input
              id={`team-name-${team.id}`}
              name="name"
              defaultValue={team.name}
              required
              disabled={updatePending}
              className="mt-1 h-10 w-full border border-grit bg-paper px-3 text-sm text-graphite disabled:bg-slab"
            />
          </label>
          <p className="pt-6 text-sm text-stone">
            {team.memberCount} member{team.memberCount === 1 ? "" : "s"} · {team.leadCount} lead{team.leadCount === 1 ? "" : "s"}
          </p>
        </div>
        <label className="text-sm text-graphite" htmlFor={`team-description-${team.id}`}>
          Description
          <input
            id={`team-description-${team.id}`}
            name="description"
            defaultValue={team.description ?? ""}
            disabled={updatePending}
            className="mt-1 h-10 w-full border border-grit bg-paper px-3 text-sm text-graphite disabled:bg-slab"
          />
        </label>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-stone">{isArchived ? "Archived teams retain current context but cannot receive new members or leads." : "Team leads are organizational context only; they do not grant capabilities."}</p>
          <button
            type="submit"
            disabled={updatePending}
            className="h-10 border border-graphite px-3 text-sm font-medium text-graphite hover:bg-slab disabled:cursor-not-allowed disabled:border-grit disabled:text-stone"
          >
            {updatePending ? "Saving..." : "Save team"}
          </button>
        </div>
      </form>
      <ActionMessage state={updateState} />

      <section className="mt-5 border-t border-grit pt-4" aria-labelledby={`team-members-${team.id}`}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 id={`team-members-${team.id}`} className="font-semibold text-graphite">Members</h3>
          {isArchived ? <span className="text-xs font-semibold uppercase tracking-wide text-stone">Archived</span> : null}
        </div>
        {teamMemberships.length ? (
          <ul className="mt-2">
            {teamMemberships.map((membership) => {
              const member = membersById.get(membership.userId);
              return member ? <TeamMemberRow key={membership.userId} team={team} member={member} membership={membership} /> : null;
            })}
          </ul>
        ) : <p className="mt-2 text-sm text-stone">No team members yet.</p>}

        {availableMembers.length && !isArchived ? (
          <form action={addAction} className="mt-3 flex flex-wrap items-end gap-2">
            <input type="hidden" name="teamId" value={team.id} />
            <input type="hidden" name="isMember" value="true" />
            <label className="flex flex-col gap-1 text-sm text-stone" htmlFor={`add-team-member-${team.id}`}>
              Add member
              <select id={`add-team-member-${team.id}`} name="userId" defaultValue={availableMembers[0]?.userId} className="h-10 border border-grit bg-paper px-3 text-sm text-graphite">
                {availableMembers.map((member) => <option key={member.userId} value={member.userId}>{member.email}</option>)}
              </select>
            </label>
            <button type="submit" disabled={addPending} className="h-10 border border-graphite px-3 text-sm font-medium text-graphite hover:bg-slab disabled:cursor-not-allowed disabled:border-grit disabled:text-stone">
              {addPending ? "Adding..." : "Add member"}
            </button>
          </form>
        ) : null}
        <ActionMessage state={addState} />
      </section>

      <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-grit pt-4">
        <form action={archiveAction}>
          <input type="hidden" name="teamId" value={team.id} />
          <input type="hidden" name="archived" value={String(!isArchived)} />
          <button type="submit" disabled={archivePending} className="text-sm font-medium text-graphite underline-offset-4 hover:underline disabled:text-stone">
            {archivePending ? "Saving..." : isArchived ? "Restore team" : "Archive team"}
          </button>
        </form>
        {team.memberCount === 0 ? (
          <form
            action={deleteAction}
            onSubmit={(event) => {
              if (!window.confirm(`Delete ${team.name}?`)) event.preventDefault();
            }}
          >
            <input type="hidden" name="teamId" value={team.id} />
            <button type="submit" disabled={deletePending} className="text-sm font-medium text-red-700 underline-offset-4 hover:underline disabled:text-red-300">
              {deletePending ? "Deleting..." : "Delete team"}
            </button>
          </form>
        ) : <p className="text-sm text-stone">Remove members before deleting this team.</p>}
      </div>
      <ActionMessage state={archiveState} />
      <ActionMessage state={deleteState} />
    </article>
  );
}

function ReportingRelationshipEditor({
  member,
  members,
}: {
  member: WorkspaceOrganizationMember;
  members: WorkspaceOrganizationMember[];
}) {
  const [state, action, pending] = useActionState(setWorkspacePrimaryManagerAction, initialState);
  const managers = members.filter((candidate) => candidate.userId !== member.userId);

  return (
    <form action={action} className="grid gap-2 border-t border-grit py-3 first:border-t-0 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,18rem)_auto] sm:items-end">
      <input type="hidden" name="reportUserId" value={member.userId} />
      <div>
        <p className="text-sm font-medium text-graphite">{member.email}</p>
        <p className="mt-1 text-xs text-stone">{member.managerEmail ? `Reports to ${member.managerEmail}` : "No direct manager"}</p>
      </div>
      <label className="text-sm text-stone" htmlFor={`manager-${member.userId}`}>
        Direct manager
        <select id={`manager-${member.userId}`} name="managerUserId" defaultValue={member.managerUserId ?? ""} disabled={pending} className="mt-1 h-10 w-full border border-grit bg-paper px-3 text-sm text-graphite disabled:bg-slab">
          <option value="">No direct manager</option>
          {managers.map((manager) => <option key={manager.userId} value={manager.userId}>{manager.email}</option>)}
        </select>
      </label>
      <button type="submit" disabled={pending} className="h-10 border border-graphite px-3 text-sm font-medium text-graphite hover:bg-slab disabled:cursor-not-allowed disabled:border-grit disabled:text-stone">
        {pending ? "Saving..." : "Save manager"}
      </button>
      <div className="sm:col-span-3"><ActionMessage state={state} /></div>
    </form>
  );
}

export function WorkspaceOrganizationManagement({
  teams,
  members,
  memberships,
}: {
  teams: WorkspaceTeam[];
  members: WorkspaceOrganizationMember[];
  memberships: WorkspaceTeamMembership[];
}) {
  const [createState, createAction, createPending] = useActionState(createWorkspaceTeamAction, initialState);

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-8 border-t border-grit pt-7">
      <section aria-labelledby="teams-heading">
        <h2 id="teams-heading" className="text-xl font-semibold text-graphite">Teams</h2>
        <p className="mt-1 text-sm text-stone">Teams, team leads, and workspace roles remain separate. Members may belong to more than one team.</p>
        <div className="mt-4 grid gap-4">
          {teams.map((team) => <TeamEditor key={team.id} team={team} members={members} memberships={memberships} />)}
        </div>
        <form action={createAction} className="mt-5 border border-grit bg-slab/40 p-4">
          <h3 className="font-semibold text-graphite">Create team</h3>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-sm text-graphite" htmlFor="new-team-name">Team name<input id="new-team-name" name="name" required className="mt-1 h-10 w-full border border-grit bg-paper px-3 text-sm" /></label>
            <label className="text-sm text-graphite" htmlFor="new-team-description">Description<input id="new-team-description" name="description" className="mt-1 h-10 w-full border border-grit bg-paper px-3 text-sm" /></label>
          </div>
          <button type="submit" disabled={createPending} className="mt-4 h-10 bg-brass px-4 text-sm font-semibold text-graphite hover:bg-brass-deep disabled:cursor-not-allowed disabled:bg-slab">
            {createPending ? "Creating..." : "Create team"}
          </button>
          <ActionMessage state={createState} />
        </form>
      </section>

      <section aria-labelledby="reporting-heading" className="border-t border-grit pt-7">
        <h2 id="reporting-heading" className="text-xl font-semibold text-graphite">Reporting relationships</h2>
        <p className="mt-1 text-sm text-stone">Each member may have one primary direct manager. Reporting relationships do not change permissions.</p>
        <div className="mt-4">
          {members.map((member) => <ReportingRelationshipEditor key={member.userId} member={member} members={members} />)}
        </div>
      </section>
    </div>
  );
}
