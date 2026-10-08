// Read-only interfaces for restore, monitor and deployment consumers. A caller
// must use the same database/transaction snapshot as its other ledger audits.
export const TRANSFER_TABLES=Object.freeze(['gp_transfer_bindings','gp_transfer_accounts','gp_transfers','gp_transfer_outbox','wallet_transfer_clearing']);
export async function transferSchema(db){
 const rows=(await db.query("SELECT c.relname,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1::text[])",[TRANSFER_TABLES])).rows;
 if(!rows.length){
  const stray=(await db.query("SELECT EXISTS(SELECT 1 FROM wallet_ledger WHERE account LIKE 'transfer:%' OR meta->>'kind' LIKE 'transfer_%') AS found")).rows[0].found;
  if(stray!==false)throw Error('TRANSFER_SCHEMA_INCOMPLETE');
  return'absent';
 }
 if(rows.length!==TRANSFER_TABLES.length||rows.some(r=>r.relkind!=='r'))throw Error('TRANSFER_SCHEMA_INCOMPLETE');
 return'present';
}
export const TRANSFER_OBLIGATIONS_SQL=`SELECT count(*)::text AS pending_transfers,
 coalesce(sum(amount_minor) FILTER(WHERE direction='IN'),0)::text AS pending_inbound_minor,
 coalesce(sum(amount_minor) FILTER(WHERE direction='OUT'),0)::text AS pending_outbound_minor
 FROM gp_transfers WHERE state='PENDING'`;
export const TRANSFER_AUDIT_SQL=`WITH entries AS (
 SELECT scope_id,account,sum(delta_available)::numeric net,sum(delta_reserved)::numeric reserved FROM wallet_ledger
 WHERE account LIKE 'transfer:%' GROUP BY scope_id,account
), order_clearing AS (
 SELECT t.scope_id,o.issuer,o.merchant,sum(CASE WHEN t.direction='IN' THEN -t.amount_minor::numeric ELSE t.amount_minor::numeric END) net
 FROM gp_transfers t JOIN gp_transfer_outbox o ON o.transfer_id=t.id WHERE t.state='SUCCEEDED' GROUP BY t.scope_id,o.issuer,o.merchant
), mismatch AS (
 SELECT 1 FROM entries e FULL JOIN wallet_transfer_clearing c USING(scope_id,account)
 WHERE coalesce(e.net,0)<>coalesce(c.net_minor,0) OR coalesce(e.reserved,0)<>0
 UNION ALL SELECT 1 FROM order_clearing o FULL JOIN wallet_transfer_clearing c USING(scope_id,issuer,merchant)
 WHERE coalesce(o.net,0)<>coalesce(c.net_minor,0)
), bad_order AS (
 SELECT 1 FROM gp_transfers t LEFT JOIN gp_transfer_outbox o ON o.transfer_id=t.id
 LEFT JOIN gp_transfer_bindings b ON b.id=t.binding_id LEFT JOIN gp_transfer_accounts a ON a.id=t.account_id
 WHERE o.transfer_id IS NULL OR b.app_id<>t.app_id OR b.scope_id<>t.scope_id OR a.app_id<>t.app_id OR
 a.binding_id<>t.binding_id OR a.external_user_id<>t.external_user_id OR
 encode(sha256(convert_to(t.request_body,'UTF8')),'hex')<>t.request_sha256 OR
 encode(sha256(convert_to(o.raw_body,'UTF8')),'hex')<>o.body_sha256 OR
 o.operation_id<>t.id OR o.issuer IS DISTINCT FROM t.binding_snapshot->>'issuer' OR o.merchant IS DISTINCT FROM t.binding_snapshot->>'merchant' OR
 (t.state='PENDING' AND (t.receipt IS NOT NULL OR o.external_transaction_id IS NOT NULL)) OR
 (t.state<>'PENDING' AND (t.receipt IS NULL OR o.result IS NULL OR o.result->>'state' IS DISTINCT FROM t.state OR
  o.result->>'operation_id' IS DISTINCT FROM o.operation_id OR o.result->>'body_sha256' IS DISTINCT FROM o.body_sha256 OR
  o.result->>'amount_minor' IS DISTINCT FROM t.amount_minor::text OR o.result->>'direction' IS DISTINCT FROM t.direction OR
  o.result->>'currency_id' IS DISTINCT FROM t.currency_id OR t.receipt->>'transfer_id' IS DISTINCT FROM t.id OR
  t.receipt->>'ledger_transaction_id' IS DISTINCT FROM t.ledger_transaction_id OR o.lease_token IS NOT NULL OR o.lease_until IS NOT NULL)) OR
 (t.state='SUCCEEDED' AND (o.external_transaction_id IS NULL OR o.result->>'transaction_id' IS DISTINCT FROM o.external_transaction_id))
), owned_holds AS (
 SELECT scope_id,external_user_id,amount_minor::numeric reserved,0::numeric credit FROM wallet_reservations WHERE state='RESERVED'
 UNION ALL SELECT scope_id,external_user_id,stake_minor,max_payout_minor FROM wallet_probability WHERE state IN ('AUTHORIZED','ACCEPTED')
 UNION ALL SELECT m.scope_id,p->>'external_user_id',0,m.payout_capacity FROM wallet_matches m CROSS JOIN LATERAL jsonb_array_elements(m.participants) p WHERE m.state='CAPTURED'
 UNION ALL SELECT scope_id,external_user_id,CASE WHEN direction='OUT' THEN amount_minor ELSE 0 END,CASE WHEN direction='IN' THEN amount_minor ELSE 0 END FROM gp_transfers WHERE state='PENDING'
), totals AS (
 SELECT scope_id,external_user_id,sum(reserved) reserved,sum(credit) credit FROM owned_holds GROUP BY scope_id,external_user_id
), held_mismatch AS (
 SELECT 1 FROM wallet_users u FULL JOIN totals h USING(scope_id,external_user_id)
 WHERE u.external_user_id IS NULL OR coalesce(h.reserved,0)<>u.reserved OR coalesce(h.credit,0)<>u.credit_pending
)
SELECT json_build_object('clearing_mismatches',(SELECT count(*) FROM mismatch),
 'transfer_order_mismatches',(SELECT count(*) FROM bad_order),
 'wallet_hold_mismatches',(SELECT count(*) FROM held_mismatch)) AS audit`;
export async function transferAudit(db){return(await db.query(TRANSFER_AUDIT_SQL)).rows[0].audit;}
export async function transferObligations(db){return(await db.query(TRANSFER_OBLIGATIONS_SQL)).rows[0];}
