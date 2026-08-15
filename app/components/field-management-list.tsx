import { updateFieldDefinition } from "@/app/actions";
import { FieldEditForm } from "@/app/components/field-edit-form";
import type { FieldDefinition } from "@/lib/domain/types";

type FieldManagementListProps = {
  workspaceId: string;
  entityTypeId: string;
  fields: FieldDefinition[];
  entityNameById: Record<string, string>;
};

export function FieldManagementList({
  workspaceId,
  entityTypeId,
  fields,
  entityNameById,
}: FieldManagementListProps) {
  const orderedFields = [...fields].sort((left, right) => {
    return left.position - right.position;
  });

  return (
    <section className="mx-auto w-full max-w-6xl border border-slate-200 bg-white p-5">
      <div className="mb-5">
        <h2 className="text-xl font-semibold text-slate-950">Manage Fields</h2>
      </div>

      <div className="divide-y divide-slate-100">
        {orderedFields.map((field) => {
          const updateFieldAction = updateFieldDefinition.bind(null, {
            workspaceId,
            entityTypeId,
            fieldDefinitionId: field.id,
          });

          return (
            <div key={field.id} className="py-4 first:pt-0 last:pb-0">
              <FieldEditForm
                field={field}
                relatedEntityName={
                  field.relatedEntityTypeId
                    ? entityNameById[field.relatedEntityTypeId]
                    : undefined
                }
                updateFieldDefinitionAction={updateFieldAction}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
