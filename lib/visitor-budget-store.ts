import {VISITOR_WALLET_MICROS,BudgetAdmissionError,type BudgetContext} from './visitor-budget-core';
/** Helper is authoritative: a signed issuer cannot remint credit for a subject. */
export async function bindBudgetSubject(db:D1Database,context:BudgetContext,now=Date.now()){
 if(!/^[a-f0-9]{64}$/.test(context.securitySubject))throw new BudgetAdmissionError('context');
 await db.prepare('INSERT INTO inference_subjects(installation,security_subject,current_session,issued_at,expires_at,last_activity_at,retain_until) VALUES(?,?,?,?,?,?,?) ON CONFLICT(installation,security_subject) DO UPDATE SET current_session=excluded.current_session,issued_at=excluded.issued_at,expires_at=excluded.expires_at,last_activity_at=excluded.last_activity_at,retain_until=MAX(inference_subjects.retain_until,excluded.retain_until) WHERE inference_subjects.expires_at<=?').bind(context.installation,context.securitySubject,context.session,context.sessionIssuedAt,context.sessionExpiresAt,now,Math.max(now,context.sessionExpiresAt)+7*86400000,now).run();
 const row=await db.prepare('SELECT current_session,issued_at,expires_at FROM inference_subjects WHERE installation=? AND security_subject=?').bind(context.installation,context.securitySubject).first<{current_session:string;issued_at:number;expires_at:number}>();
 if(!row||row.current_session!==context.session||row.issued_at!==context.sessionIssuedAt||row.expires_at!==context.sessionExpiresAt)throw new BudgetAdmissionError('context');
 await db.prepare('UPDATE inference_subjects SET last_activity_at=?,retain_until=MAX(retain_until,?) WHERE installation=? AND security_subject=?').bind(now,Math.max(now,context.sessionExpiresAt)+7*86400000,context.installation,context.securitySubject).run();
}
export class VisitorBudgetStore{
 constructor(public db:D1Database,public now:()=>number=Date.now){}
 async reserve(context:BudgetContext,cost:number){
  if(!Number.isSafeInteger(cost)||cost<1||cost>VISITOR_WALLET_MICROS)throw new Error('Admission closed');
  const now=this.now(),day=Math.floor(now/86400000),scope=context.purpose.startsWith('visitor_')?'visitor':'operator';
  await bindBudgetSubject(this.db,context,now);
  // One INSERT and its triggers are the transaction. Concurrent requests cannot
  // both observe the last credit, daily slot, or concurrency lease as available.
  try{await this.db.prepare('INSERT OR IGNORE INTO inference_reservations(request_key,installation,security_subject,session,purpose,model,body_digest,policy,cost_micros,day,scope,state,created_at,lease_until,session_expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,\'reserved\',?,?,?)').bind(context.requestKey,context.installation,context.securitySubject,context.session,context.purpose,context.model,context.bodyDigest,context.policy,cost,day,scope,now,now+60000,context.sessionExpiresAt).run();}catch{
   const daily=await this.db.prepare('SELECT calls FROM inference_daily WHERE day=?').bind(day).first<{calls:number}>();if(daily&&daily.calls>=100)throw new BudgetAdmissionError('global');
   const active=await this.db.prepare('SELECT COUNT(*) AS count FROM inference_reservations WHERE lease_until>?').bind(now).first<{count:number}>();if(active&&active.count>=4)throw new BudgetAdmissionError('concurrency');
   throw new BudgetAdmissionError('wallet');
  }
  const row=await this.db.prepare('SELECT * FROM inference_reservations WHERE request_key=?').bind(context.requestKey).first<{installation:string;security_subject:string;session:string;purpose:string;model:string;body_digest:string;policy:string;cost_micros:number;state:string}>();
  if(!row)throw new Error('Admission unavailable');if(row.installation!==context.installation||row.security_subject!==context.securitySubject||row.session!==context.session||row.purpose!==context.purpose||row.model!==context.model||row.body_digest!==context.bodyDigest||row.policy!==context.policy||row.cost_micros!==cost)throw new Error('Admission conflict');
  return row;
 }
 async dispatch(requestKey:string){const r=await this.db.prepare("UPDATE inference_reservations SET state='dispatched',lease_until=9223372036854775807 WHERE request_key=? AND state='reserved' AND lease_until>? AND session_expires_at>?").bind(requestKey,this.now(),this.now()).run();return r.meta.changes===1;}
 async finish(requestKey:string,state:'complete'|'unknown'){await this.db.prepare("UPDATE inference_reservations SET state=?,lease_until=CASE WHEN ?='complete' THEN 0 ELSE lease_until END WHERE request_key=? AND state='dispatched'").bind(state,state,requestKey).run();}
 async prune(){const cutoff=this.now()-7*86400000;await this.db.batch([
  this.db.prepare("DELETE FROM inference_reservations WHERE request_key IN (SELECT request_key FROM inference_reservations WHERE session_expires_at<=? AND state IN ('reserved','complete') LIMIT 100)").bind(cutoff),
  this.db.prepare('DELETE FROM inference_wallets WHERE session IN (SELECT w.session FROM inference_wallets w WHERE w.session_expires_at<=? AND NOT EXISTS(SELECT 1 FROM inference_reservations r WHERE r.session=w.session) LIMIT 100)').bind(cutoff),
  this.db.prepare('DELETE FROM inference_daily WHERE day<?').bind(Math.floor(cutoff/86400000)),
  this.db.prepare("DELETE FROM inference_subjects WHERE rowid IN (SELECT s.rowid FROM inference_subjects s WHERE s.retain_until<=? AND NOT EXISTS(SELECT 1 FROM inference_reservations r WHERE r.installation=s.installation AND r.security_subject=s.security_subject AND r.state IN ('dispatched','unknown')) LIMIT 100)").bind(this.now())]);}
}
/** At most 100 normalized-image attempts/day, no inference-wallet debit. */
export class VisitorImageBudgetStore{
 constructor(public db:D1Database,public now:()=>number=Date.now){}
 async reserve(context:BudgetContext){
  await bindBudgetSubject(this.db,context,this.now());
  try{await this.db.prepare("INSERT OR IGNORE INTO image_transform_reservations(request_key,installation,security_subject,session,purpose,body_digest,policy,day,state,created_at,session_expires_at) VALUES(?,?,?,?,?,?,?,?,'reserved',?,?)").bind(context.requestKey,context.installation,context.securitySubject,context.session,context.purpose,context.bodyDigest,context.policy,Math.floor(this.now()/86400000),this.now(),context.sessionExpiresAt).run();}catch{throw new BudgetAdmissionError('global');}
  const row=await this.db.prepare('SELECT installation,security_subject,session,purpose,body_digest,policy FROM image_transform_reservations WHERE request_key=?').bind(context.requestKey).first<{installation:string;security_subject:string;session:string;purpose:string;body_digest:string;policy:string}>();
  if(!row||row.installation!==context.installation||row.security_subject!==context.securitySubject||row.session!==context.session||row.purpose!==context.purpose||row.body_digest!==context.bodyDigest||row.policy!==context.policy)throw new BudgetAdmissionError('context');
 }
 async dispatch(context:BudgetContext){const result=await this.db.prepare("UPDATE image_transform_reservations SET state='dispatched' WHERE request_key=? AND state='reserved' AND created_at>? AND session_expires_at>?").bind(context.requestKey,this.now()-60000,this.now()).run();return result.meta.changes===1;}
 async finish(requestKey:string,state:'complete'|'unknown'){await this.db.prepare("UPDATE image_transform_reservations SET state=? WHERE request_key=? AND state='dispatched'").bind(state,requestKey).run();}
 async prune(){const cutoff=this.now()-7*86400000;await this.db.batch([this.db.prepare("DELETE FROM image_transform_reservations WHERE request_key IN (SELECT request_key FROM image_transform_reservations WHERE session_expires_at<=? AND state IN ('reserved','complete') LIMIT 100)").bind(cutoff),this.db.prepare('DELETE FROM image_transform_daily WHERE day<?').bind(Math.floor(cutoff/86400000))]);}
}
