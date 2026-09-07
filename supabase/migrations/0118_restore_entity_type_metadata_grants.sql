-- Corrective migration for 0117_entity_type_governance_audit.sql.
-- The established schema.manage/RLS contract intentionally permits direct
-- authenticated metadata updates, including while impersonating a user whose
-- effective identity lacks schema.manage. 0117 revoked those table privileges
-- wholesale, breaking that contract. Lifecycle writes remain RPC-only.

grant update (name, slug, description, updated_at) on table entity_types to authenticated;
grant update (display_field_definition_id, updated_at) on table entity_types to authenticated;

