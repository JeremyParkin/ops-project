-- Corrective migration for a defect in 0137_choice_option_safe_delete.sql
-- (applied to both development/E2E and kinema-dogfood; 0137 itself is not
-- edited, per this project's immutable-migration convention).
--
-- 0137 dropped and recreated governance_audit_events_event_type_check to
-- add 'choice_option_deleted', but based its replacement list on 0129's
-- definition instead of the actual latest one. 0130_person_identity_
-- governance_audit_sql (applied after 0129, before 0137) had already added
-- 'person_entity_type_changed' to this same constraint -- 0137 silently
-- dropped that value, since it never inspected 0130 at all.
--
-- Impact: set_person_entity_type_authorized's governance-audit insert
-- (event_type = 'person_entity_type_changed') has been rejected by this
-- constraint on both environments since 0137 was applied -- not merely a
-- missing audit entry, but the whole RPC call failing outright (the insert
-- is inside its transaction), so designating/changing a workspace's Person
-- entity type has been broken since 0137 landed. Found via this
-- migration's own DB/RPC commit test
-- (lib/domain/choice-option-delete-commit.test.ts's Quality Review
-- fixture, which designates a Person type), not via inspection alone.
--
-- 0130 also added governance_audit_events_subject_kind_check and
-- governance_audit_events_subject_hierarchy_check in the same statement;
-- 0137 never touched either of those (only event_type_check), so both are
-- unaffected and need no correction here.
--
-- Fix: restore the constraint to 0130's complete list, plus 0137's own
-- intended addition. No data migration needed -- no row has ever
-- successfully been inserted with an event_type this constraint would
-- reject, by definition of the constraint failing the insert.

alter table governance_audit_events
  drop constraint if exists governance_audit_events_event_type_check;

alter table governance_audit_events
  add constraint governance_audit_events_event_type_check check (event_type in (
    'field_created', 'field_updated', 'field_archived', 'field_restored', 'field_deleted',
    'choice_option_created', 'choice_option_updated', 'choice_option_archived', 'choice_option_restored',
    'choice_option_deleted',
    'entity_type_created', 'entity_type_updated', 'entity_type_archived', 'entity_type_restored', 'entity_type_deleted',
    'workflow_created', 'workflow_updated', 'workflow_enabled', 'workflow_disabled', 'workflow_deleted',
    'process_template_created', 'process_template_updated', 'process_template_archived',
    'process_template_restored', 'process_template_deleted',
    'workspace_member_invited', 'workspace_member_invitation_cancelled',
    'workspace_member_activated', 'workspace_member_deactivated', 'workspace_member_role_changed',
    'workspace_role_created', 'workspace_role_updated', 'workspace_role_deleted',
    'workspace_team_created', 'workspace_team_updated', 'workspace_team_archived',
    'workspace_team_restored', 'workspace_team_deleted', 'workspace_team_member_added',
    'workspace_team_member_removed', 'workspace_team_lead_added', 'workspace_team_lead_removed',
    'workspace_primary_manager_changed',
    'people_sensitive_access_configured',
    'quality_review_lifecycle_configured', 'quality_review_presentation_configured',
    'person_entity_type_changed'
  ));
