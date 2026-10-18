/**
 * Names an owner for sessions that have none.
 *
 * Sessions created before session ownership existed have no owner, and no instructor can run or review
 * them until an operator decides who should. This script is that decision; the migration never guesses.
 *
 * Run: pnpm --filter @vyuha/server sessions:assign-owner -- --list
 *        (lists the sessions without an owner)
 *      pnpm --filter @vyuha/server sessions:assign-owner -- --owner <email> --session <id or code> [...]
 *        (gives the named sessions to that instructor)
 *      pnpm --filter @vyuha/server sessions:assign-owner -- --owner <email> --all-unowned
 *        (gives every session without an owner to that instructor)
 *
 * Only sessions without an owner are changed; a session that already has one is reported and skipped.
 */
import { prisma } from '../src/db';

function argValues(flag: string): string[] {
  const values: string[] = [];
  process.argv.forEach((arg, i) => {
    const next = process.argv[i + 1];
    if (arg === flag && next !== undefined && !next.startsWith('--')) values.push(next);
  });
  return values;
}

async function listUnowned(): Promise<void> {
  const rows = await prisma.session.findMany({
    where: { ownerId: null },
    orderBy: { createdAt: 'asc' },
    include: { scenario: { select: { title: true } }, _count: { select: { players: true } } },
  });
  if (rows.length === 0) {
    console.log('Every session has an owner.');
    return;
  }
  console.log(`${rows.length} session(s) without an owner:`);
  for (const s of rows) {
    console.log(
      `  ${s.id}  code ${s.code}  ${s.status}  ${s.createdAt.toISOString()}  ` +
        `${s.scenario.title}  (${s._count.players} trainee(s))`,
    );
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--list')) {
    await listUnowned();
    return;
  }
  const [email] = argValues('--owner');
  const refs = argValues('--session');
  const all = process.argv.includes('--all-unowned');
  if (!email || (refs.length === 0 && !all) || (refs.length > 0 && all)) {
    throw new Error(
      'Usage: --list | --owner <instructor email> (--session <id or code> ... | --all-unowned)',
    );
  }
  const owner = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!owner || owner.role !== 'INSTRUCTOR') {
    throw new Error(`No instructor account ${email}`);
  }

  if (all) {
    const updated = await prisma.session.updateMany({
      where: { ownerId: null },
      data: { ownerId: owner.id },
    });
    console.log(`${owner.email} now owns ${updated.count} session(s) that had no owner.`);
    return;
  }

  for (const ref of refs) {
    const session = await prisma.session.findFirst({
      where: { OR: [{ id: ref }, { code: ref.toUpperCase() }] },
    });
    if (!session) {
      console.log(`  ${ref}: no such session`);
      continue;
    }
    // The ownerId condition makes the update a no-op if someone assigned an owner meanwhile.
    const updated = await prisma.session.updateMany({
      where: { id: session.id, ownerId: null },
      data: { ownerId: owner.id },
    });
    console.log(
      updated.count === 1
        ? `  ${session.code}: now owned by ${owner.email}`
        : `  ${session.code}: already has an owner, left unchanged`,
    );
  }
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
