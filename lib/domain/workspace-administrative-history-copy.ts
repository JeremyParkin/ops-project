import type { WorkspaceAdministrativeHistoryEvent } from "./workspace-administrative-history-repository";

export type AdministrativeHistoryCopy = {
  title: string;
  subject: string;
};

function quoted(value: string | null | undefined, fallback: string) {
  return `“${value || fallback}”`;
}

function subjectType(kind: string | null) {
  const labels: Record<string, string> = {
    entity_type: "Business object",
    field: "Field",
    choice_option: "Choice",
    workflow: "Automation",
    process_template: "Process template",
    workspace_invitation: "Invitation",
    workspace_member: "Member",
    workspace_role: "Role",
    workspace_team: "Team",
    workspace: "Workspace",
    person: "Person",
    user: "User",
  };
  return (kind && labels[kind]) || "Administrative change";
}

function detailString(event: WorkspaceAdministrativeHistoryEvent, key: string) {
  const value = event.details[key];
  return typeof value === "string" ? value : undefined;
}

function subjectText(event: WorkspaceAdministrativeHistoryEvent) {
  return `${subjectType(event.subjectKind)}: ${event.subjectLabel || event.subjectId || "Unavailable"}`;
}

export function formatWorkspaceAdministrativeHistoryEvent(event: WorkspaceAdministrativeHistoryEvent): AdministrativeHistoryCopy {
  const name = quoted(event.subjectLabel, subjectType(event.subjectKind));
  const oldName = detailString(event, "old_name");
  const newName = detailString(event, "new_name");
  const oldManager = detailString(event, "old_manager_email") || detailString(event, "old_manager_id");
  const newManager = detailString(event, "new_manager_email") || detailString(event, "new_manager_id");
  const email = detailString(event, "email") || event.subjectLabel || "member";
  const effective = detailString(event, "effective_user_id") || event.effectiveUserId;
  const reason = detailString(event, "reason");

  switch (event.eventType) {
    case "entity_type_created": return { title: `Created business object ${name}`, subject: subjectText(event) };
    case "entity_type_updated": return { title: `Updated business object ${name}`, subject: subjectText(event) };
    case "entity_type_archived": return { title: `Archived business object ${name}`, subject: subjectText(event) };
    case "entity_type_restored": return { title: `Restored business object ${name}`, subject: subjectText(event) };
    case "entity_type_deleted": return { title: `Deleted business object ${name}`, subject: subjectText(event) };
    case "field_created": return { title: `Added field ${name}`, subject: subjectText(event) };
    case "field_updated": return { title: oldName && newName ? `Renamed field ${quoted(oldName, "field")} to ${quoted(newName, "field")}` : `Updated field ${name}`, subject: subjectText(event) };
    case "field_archived": return { title: `Archived field ${name}`, subject: subjectText(event) };
    case "field_restored": return { title: `Restored field ${name}`, subject: subjectText(event) };
    case "field_deleted": return { title: `Deleted field ${name}`, subject: subjectText(event) };
    case "choice_option_created": return { title: `Added choice ${name}`, subject: subjectText(event) };
    case "choice_option_updated": return { title: `Updated choice ${name}`, subject: subjectText(event) };
    case "choice_option_archived": return { title: `Archived choice ${name}`, subject: subjectText(event) };
    case "choice_option_restored": return { title: `Restored choice ${name}`, subject: subjectText(event) };
    case "workflow_created": return { title: `Created Automation ${name}`, subject: subjectText(event) };
    case "workflow_updated": return { title: `Updated Automation ${name}`, subject: subjectText(event) };
    case "workflow_enabled": return { title: `Enabled Automation ${name}`, subject: subjectText(event) };
    case "workflow_disabled": return { title: `Disabled Automation ${name}`, subject: subjectText(event) };
    case "workflow_deleted": return { title: `Deleted Automation ${name}`, subject: subjectText(event) };
    case "process_template_created": return { title: `Created process template ${name}`, subject: subjectText(event) };
    case "process_template_updated": return { title: `Updated process template ${name}`, subject: subjectText(event) };
    case "process_template_archived": return { title: `Archived process template ${name}`, subject: subjectText(event) };
    case "process_template_restored": return { title: `Restored process template ${name}`, subject: subjectText(event) };
    case "process_template_deleted": return { title: `Deleted process template ${name}`, subject: subjectText(event) };
    case "workspace_member_invited": return { title: `Invited ${email} to the workspace`, subject: subjectText(event) };
    case "workspace_member_invitation_cancelled": return { title: `Cancelled ${email}’s workspace invitation`, subject: subjectText(event) };
    case "workspace_member_activated": return { title: `Activated member ${email}`, subject: subjectText(event) };
    case "workspace_member_deactivated": return { title: `Deactivated member ${email}`, subject: subjectText(event) };
    case "workspace_member_role_changed": return { title: `Changed ${email}’s role`, subject: subjectText(event) };
    case "workspace_role_created": return { title: `Created role ${name}`, subject: subjectText(event) };
    case "workspace_role_updated": return { title: `Updated role ${name}`, subject: subjectText(event) };
    case "workspace_role_deleted": return { title: `Deleted role ${name}`, subject: subjectText(event) };
    case "workspace_team_created": return { title: `Created team ${name}`, subject: subjectText(event) };
    case "workspace_team_updated": return { title: `Updated team ${name}`, subject: subjectText(event) };
    case "workspace_team_archived": return { title: `Archived team ${name}`, subject: subjectText(event) };
    case "workspace_team_restored": return { title: `Restored team ${name}`, subject: subjectText(event) };
    case "workspace_team_deleted": return { title: `Deleted team ${name}`, subject: subjectText(event) };
    case "workspace_team_member_added": return { title: `Added ${email} to team ${name}`, subject: subjectText(event) };
    case "workspace_team_member_removed": return { title: `Removed ${email} from team ${name}`, subject: subjectText(event) };
    case "workspace_team_lead_added": return { title: `Added ${email} as a lead of team ${name}`, subject: subjectText(event) };
    case "workspace_team_lead_removed": return { title: `Removed ${email} as a lead of team ${name}`, subject: subjectText(event) };
    case "workspace_primary_manager_changed": return { title: newManager ? `Changed ${name}’s primary manager from ${oldManager || "None"} to ${newManager}` : `Cleared ${name}’s primary manager`, subject: subjectText(event) };
    case "person_entity_type_changed": return { title: newName ? `Designated ${quoted(newName, "business object")} as the Person business object` : "Cleared the Person business object", subject: subjectText(event) };
    case "people_sensitive_access_configured": return { title: `Configured people-sensitive access for ${name}`, subject: subjectText(event) };
    case "quality_review_lifecycle_configured": return { title: `Configured Quality Review lifecycle for ${name}`, subject: subjectText(event) };
    case "quality_review_presentation_configured": return { title: `Configured Quality Review presentation for ${name}`, subject: subjectText(event) };
    case "person_linked": return { title: `Linked ${email} to Person record ${quoted(detailString(event, "person_label"), "Person record")}`, subject: subjectText(event) };
    case "person_unlinked": return { title: `Unlinked ${email} from Person record ${quoted(detailString(event, "person_label"), "Person record")}`, subject: subjectText(event) };
    case "impersonation_started": return { title: `Started impersonating ${effective || "another user"}`, subject: subjectText(event) };
    case "impersonation_ended": return { title: reason === "replaced_by_new_session" ? `Ended impersonation of ${effective || "another user"} because the session was replaced` : reason === "target_deactivated" ? `Ended impersonation of ${effective || "another user"} because the account was deactivated` : `Ended impersonation of ${effective || "another user"}`, subject: subjectText(event) };
    default: return { title: "Administrative change", subject: subjectText(event) };
  }
}

export function administrativeHistoryActorLabel(event: WorkspaceAdministrativeHistoryEvent) {
  const actor = event.actorUserId || "Unknown actor";
  return event.effectiveUserId && event.effectiveUserId !== event.actorUserId
    ? `${actor} · Effective user ${event.effectiveUserId}`
    : actor;
}

export function administrativeHistoryDetailLabel(key: string) {
  const labels: Record<string, string> = {
    old_name: "Old name", new_name: "New name", old_description: "Old description", new_description: "New description",
    old_capabilities: "Previous capabilities", new_capabilities: "Current capabilities", added_capabilities: "Added capabilities",
    removed_capabilities: "Removed capabilities", email: "Email", role_id: "Role", role_name: "Role name", status: "Status",
    previous_status: "Previous status", reason: "Reason", session_id: "Session", effective_user_id: "Effective user",
    old_manager_id: "Previous manager", new_manager_id: "New manager", old_manager_email: "Previous manager email", new_manager_email: "New manager email",
    operation: "Operation", person_record_id: "Person record", person_label: "Person label", person_entity_type_id: "Person business object",
  };
  return labels[key] || key.replaceAll("_", " ").replace(/^./, (value) => value.toUpperCase());
}
