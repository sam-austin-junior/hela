import { createPool, migrate } from '../db.js';

const db = createPool();
const applied = await migrate(db);
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
await db.end();
