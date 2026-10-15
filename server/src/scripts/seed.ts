import { createPool, migrate } from '../db.js';
import { applyRules } from '../services/finance.js';
import { DEMO_PIN, seedDemo } from './seed-data.js';

// Rebuilds the demo database from scratch. The audit log is append-only,
// so a reset drops the whole schema rather than deleting rows.

const db = createPool();
await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
await migrate(db);
const { transactions } = await seedDemo(db);
const left = await applyRules(db, 'stu_demo');
console.log(`Seeded the demo student: ${transactions} transactions, ${left} left uncategorised for the model.`);
console.log(`Demo app PIN (test value): ${DEMO_PIN}`);
await db.end();
