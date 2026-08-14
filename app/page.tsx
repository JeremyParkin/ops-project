import { createRecord } from "./actions";
import { EntityRecordsTable } from "./components/entity-records-table";
import { RecordCreateForm } from "./components/record-create-form";
import {
  DEMO_CLIENT_ENTITY_TYPE_ID,
  DEMO_WORKSPACE_ID,
} from "@/lib/domain/demo-ids";
import { getEntityContext } from "@/lib/domain/metadata-repository";
import { listEntityRecords } from "@/lib/domain/record-repository";

export const dynamic = "force-dynamic";

export default async function Home() {
  const context = {
    workspaceId: DEMO_WORKSPACE_ID,
    entityTypeId: DEMO_CLIENT_ENTITY_TYPE_ID,
  };
  const [{ entityType, fields }, records] = await Promise.all([
    getEntityContext(context),
    listEntityRecords(context),
  ]);
  const createEntityRecord = createRecord.bind(null, context);

  return (
    <main className="flex flex-1 flex-col gap-8 bg-background px-6 py-10 text-foreground sm:px-10">
      <RecordCreateForm
        entityType={entityType}
        fields={fields}
        createRecordAction={createEntityRecord}
      />
      <EntityRecordsTable
        entityType={entityType}
        fields={fields}
        records={records}
      />
    </main>
  );
}
