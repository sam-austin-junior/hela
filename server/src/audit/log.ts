import { createHash } from 'node:crypto';
import { withTx, type Db, type Tx } from '../db.js';
import { clock } from '../clock.js';

// Append-only, hash-chained audit log. Each entry stores the hash of the
// previous one, so editing or deleting any entry breaks every hash after it.
// The table also has triggers that refuse UPDATE, DELETE and TRUNCATE.

export const GENESIS_HASH = '0'.repeat(64);

export type AuditKind =
  | 'tool_call'
  | 'proposal_created'
  | 'policy_decision'
  | 'otp_issued'
  | 'student_confirmed'
  | 'student_denied'
  | 'payment_executed'
  | 'payment_failed'
  | 'tier_changed'
  | 'payee_approved'
  | 'schedule_created'
  | 'schedule_approved'
  | 'schedule_revoked'
  | 'payment_method_linked'
  | 'category_corrected'
  | 'model_refusal'
  | 'limits_changed'
  | 'payee_added'
  | 'data_exported';

/** JSON with object keys sorted, so the same data always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export function entryHash(prevHash: string, at: string, kind: string, studentId: string | null, data: unknown): string {
  return createHash('sha256')
    .update(`${prevHash}\n${at}\n${kind}\n${studentId ?? ''}\n${canonicalJson(data)}`)
    .digest('hex');
}

const AUDIT_LOCK = 0x4e1a; // any constant; serialises appends so the chain has one head

export async function appendAudit(
  tx: Tx,
  entry: { studentId: string | null; kind: AuditKind; data: unknown },
): Promise<{ seq: number; hash: string }> {
  await tx.query('SELECT pg_advisory_xact_lock($1)', [AUDIT_LOCK]);
  const head = await tx.query<{ hash: string }>('SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1');
  const prev = head.rows[0]?.hash ?? GENESIS_HASH;
  const at = clock.now().toISOString();
  // Round-trip through JSON so what we hash is exactly what jsonb stores.
  const data = JSON.parse(JSON.stringify(entry.data ?? {}));
  const hash = entryHash(prev, at, entry.kind, entry.studentId, data);
  const res = await tx.query<{ seq: number }>(
    `INSERT INTO audit_log (student_id, at, kind, data, prev_hash, hash)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING seq`,
    [entry.studentId, at, entry.kind, JSON.stringify(data), prev, hash],
  );
  return { seq: res.rows[0]!.seq, hash };
}

/** Append in its own transaction, for callers that are not already in one. */
export function audit(db: Db, entry: { studentId: string | null; kind: AuditKind; data: unknown }) {
  return withTx(db, (tx) => appendAudit(tx, entry));
}

export interface ChainCheck {
  ok: boolean;
  entries: number;
  headHash: string;
  firstBrokenSeq?: number;
  problem?: string;
}

export async function verifyChain(db: Db): Promise<ChainCheck> {
  const rows = (
    await db.query<{ seq: number; student_id: string | null; at: Date; kind: string; data: unknown; prev_hash: string; hash: string }>(
      'SELECT seq, student_id, at, kind, data, prev_hash, hash FROM audit_log ORDER BY seq',
    )
  ).rows;
  let prev = GENESIS_HASH;
  for (const r of rows) {
    if (r.prev_hash !== prev) {
      return { ok: false, entries: rows.length, headHash: prev, firstBrokenSeq: r.seq, problem: 'An entry is missing or out of order.' };
    }
    const expected = entryHash(r.prev_hash, r.at.toISOString(), r.kind, r.student_id, r.data);
    if (expected !== r.hash) {
      return { ok: false, entries: rows.length, headHash: prev, firstBrokenSeq: r.seq, problem: 'An entry was changed after it was written.' };
    }
    prev = r.hash;
  }
  return { ok: true, entries: rows.length, headHash: prev };
}
