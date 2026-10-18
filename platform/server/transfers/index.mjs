import {readFile} from 'node:fs/promises';

/** Transfer-ledger tables (first-party era) stay in the schema so the monitor and restore audits keep their contract. */
export async function migrateTransfers(pool){
 const db=await pool.connect();
 try{await db.query('BEGIN');await db.query(await readFile(new URL('./schema.sql',import.meta.url),'utf8'));await db.query('COMMIT');}
 catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
