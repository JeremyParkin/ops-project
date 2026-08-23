-- create_entity_type_with_fields remains SECURITY INVOKER and assigns the
-- first text field as the new entity's display field.
grant update (display_field_definition_id, updated_at)
  on table entity_types to authenticated;
