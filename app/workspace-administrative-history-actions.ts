"use server";

import { getActiveWorkspaceId } from "@/lib/auth/workspace";
import {
  listWorkspaceAdministrativeHistory,
  type WorkspaceAdministrativeHistoryCursor,
  type WorkspaceAdministrativeHistoryFilters,
} from "@/lib/domain/workspace-administrative-history-repository";

export async function loadMoreAdministrativeHistory(
  cursor: WorkspaceAdministrativeHistoryCursor,
  filters: WorkspaceAdministrativeHistoryFilters,
) {
  const { workspaceId } = await getActiveWorkspaceId();
  return listWorkspaceAdministrativeHistory({ workspaceId, cursor, filters });
}
