import { Db } from '../src/common/db';
import { POLICY_VERSION } from '../src/classification/ontology';

// Defaults to a count-only preview. Apply after migrations, with workers running.
async function main() {
  const db = new Db();
  const apply = process.argv.includes('--apply');
  const userArg = process.argv.find((arg) => arg.startsWith('--user='));
  const userId = userArg?.slice('--user='.length);
  const where = {
    status: { in: ['requires_user_tagging', 'failed'] },
    policyVersion: { not: POLICY_VERSION },
    validationIssues: { isEmpty: true },
    ...(userId ? { userId } : {}),
  };
  try {
    const candidates = await db.transaction.count({ where });
    if (!apply) {
      console.log(JSON.stringify({ mode: 'preview', candidates, policyVersion: POLICY_VERSION }));
      return;
    }
    let cursor: string | undefined,
      queued = 0;
    for (;;) {
      const rows = await db.transaction.findMany({
        where: { ...where, ...(cursor ? { id: { gt: cursor } } : {}) },
        orderBy: { id: 'asc' },
        take: 100,
        select: { id: true, revision: true },
      });
      if (!rows.length) break;
      for (const row of rows)
        await db.$transaction(async (tx) => {
          const current = await tx.transaction.findFirst({
            where: { ...where, id: row.id, revision: row.revision },
          });
          if (!current) return;
          await tx.classificationTask.upsert({
            where: { transactionId_revision: { transactionId: row.id, revision: row.revision } },
            create: { transactionId: row.id, revision: row.revision },
            update: { status: 'pending', lastDispatchedAt: null },
          });
          queued++;
        });
      cursor = rows.at(-1)!.id;
    }
    console.log(JSON.stringify({ mode: 'applied', queued, policyVersion: POLICY_VERSION }));
  } finally {
    await db.$disconnect();
  }
}
void main().catch(() => {
  process.stderr.write('RECLASSIFICATION_FAILED\n');
  process.exitCode = 1;
});
