export const workspaceCapabilities = [
  "workspace.manage_members",
  "workspace.manage_roles",
  "workspace.manage_organization",
  "workspace.manage_settings",
  "schema.manage",
  "automation.manage",
  "records.operate",
  "processes.operate",
  "operations.view",
  "workspace.impersonate_users",
] as const;

export type WorkspaceCapability = (typeof workspaceCapabilities)[number];

export function isWorkspaceCapability(value: string): value is WorkspaceCapability {
  return workspaceCapabilities.includes(value as WorkspaceCapability);
}
