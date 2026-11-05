import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createAbuseDb,root} from './fixtures/visitor-abuse-d1.mjs';

const output=await build({entryPoints:[path.join(root,'lib/visitor-abuse-store.ts')],bundle:true,write:false,format:'esm',platform:'node',target:'node22'});
const {VisitorAbuseStore}=await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
const now=1_800_000_000_000,workspace='synthetic-installation',subject='a'.repeat(64),requestKey='request-key-visitor-0001';

test('one warning then a second verified offence blocks; request-key replay is not a second offence',async t=>{
 const db=await createAbuseDb(t),store=new VisitorAbuseStore(db,workspace,()=>now);
 const first=await store.offense(subject,'session',requestKey,'targeted_harassment','you are a worthless idiot','alphabetizing imaginary clouds',false);
 assert.equal(first.action,'warn');
 const replay=await store.offense(subject,'session',requestKey,'targeted_harassment','you are a worthless idiot','alphabetizing imaginary clouds',false);
 assert.equal(replay.action,'warn');
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM visitor_abuse_receipts').first()).n,1);
 assert.equal((await db.prepare('SELECT revision FROM visitor_abuse_subjects WHERE workspace_id=? AND subject_hash=?').bind(workspace,subject).first()).revision,1);
 const second=await store.offense(subject,'session','request-key-visitor-0002','targeted_harassment','you are a worthless idiot','drawing portraits of fictional potatoes',false);
 assert.equal(second.action,'block');
 assert.equal((await store.blocked(subject)).action,'block');
});

test('block receipt and encrypted-IP outbox target commit atomically, including rollback on outbox failure',async t=>{
 const db=await createAbuseDb(t),store=new VisitorAbuseStore(db,workspace,()=>now);
 await db.prepare("CREATE TRIGGER fail_abuse_waf BEFORE INSERT ON visitor_abuse_waf BEGIN SELECT RAISE(ABORT,'synthetic outbox failure'); END").run();
 await assert.rejects(store.offense(subject,'ip','request-key-visitor-rollback','structured_jailbreak','bounded verified evidence','cataloguing unusually dramatic pebbles',true,'ciphertext-sentinel'));
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM visitor_abuse_subjects').first()).n,0);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM visitor_abuse_receipts').first()).n,0);
 await db.prepare('DROP TRIGGER fail_abuse_waf').run();
 const created=await store.offense(subject,'ip','request-key-visitor-commit','structured_jailbreak','bounded verified evidence','cataloguing unusually dramatic pebbles',true,'ciphertext-sentinel');
 assert.equal(created.action,'block');
 const row=await db.prepare('SELECT desired,generation,ip_ciphertext,state,operation_key FROM visitor_abuse_waf').first();
 assert.deepEqual(row,{desired:1,generation:1,ip_ciphertext:'ciphertext-sentinel',state:'pending',operation_key:`visitor-abuse:${workspace}:${subject}`});
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM visitor_abuse_receipts').first()).n,1);
});

test('owner unblock is revision-checked, audited, and leaves remote deletion pending reconciliation',async t=>{
 const db=await createAbuseDb(t),store=new VisitorAbuseStore(db,workspace,()=>now);
 await store.offense(subject,'ip',requestKey,'structured_jailbreak','bounded verified evidence','drawing portraits of fictional potatoes',true,'ciphertext-sentinel');
 await assert.rejects(store.unblock(subject,0,'verified-owner-subject'),/changed/);
 assert.equal((await db.prepare('SELECT desired,generation FROM visitor_abuse_waf').first()).desired,1);
 const result=await store.unblock(subject,1,'verified-owner-subject');
 assert.deepEqual(result,{unblocked:true,edge:'pending_reconciliation'});
 assert.deepEqual(await db.prepare('SELECT desired,generation,state FROM visitor_abuse_waf').first(),{desired:0,generation:2,state:'pending'});
 assert.equal((await db.prepare('SELECT actor,action FROM visitor_abuse_audit').first()).actor,'verified-owner-subject');
});

test('retention removes only inactive resolved records and preserves active or unresolved safety state',async t=>{
 const db=await createAbuseDb(t),store=new VisitorAbuseStore(db,workspace,()=>now),cutoff=now-7*86400000;
 const stale='d'.repeat(64),activeWarning='e'.repeat(64),activeBlock='f'.repeat(64),settled='1'.repeat(64);
 const unresolved=[
  ['2'.repeat(64),1,'pending',null,''],
  ['3'.repeat(64),1,'unknown',null,'operation_receipt_missing'],
  ['4'.repeat(64),1,'remote_pending','a'.repeat(32),null],
  ['5'.repeat(64),1,'confirmed_foreign',null,'foreign_item_not_owned'],
  ['6'.repeat(64),0,'needs_review',null,'foreign_item_ownership'],
  ['7'.repeat(64),1,'terminal',null,'auth'],
 ];
 const putSubject=async(subject,warning=0,blocked=0)=>db.prepare('INSERT INTO visitor_abuse_subjects(workspace_id,subject_hash,scope,warning_until,blocked_until,revision,updated_at) VALUES(?,?,?,?,?,1,?)').bind(workspace,subject,'ip',warning,blocked,cutoff-1).run();
 const putWaf=async(subject,desired,state,operationId=null,attention=null)=>db.prepare('INSERT INTO visitor_abuse_waf(workspace_id,subject_hash,ip_ciphertext,desired,generation,expires_at,state,operation_key,operation_id,attention,updated_at) VALUES(?,?,?,?,1,?,?,?,?,?,?)').bind(workspace,subject,'sealed-ciphertext',desired,now+86400000,state,`visitor-abuse:${workspace}:${subject}`,operationId,attention,cutoff-1).run();
 await putSubject(stale);await db.prepare("INSERT INTO visitor_abuse_audit(id,workspace_id,subject_hash,actor,action,created_at) VALUES('audit-stale',?,?,'owner','old_action',?)").bind(workspace,stale,cutoff-1).run();
 await db.prepare("INSERT INTO visitor_abuse_receipts(id,workspace_id,subject_hash,request_key,reason,evidence,action,until_at,hobby,created_at,expires_at) VALUES('receipt-stale',?,?,'old-request','reason','bounded','warn',?,?,?,?)").bind(workspace,stale,cutoff-1,'safe hobby',cutoff-2,cutoff-1).run();
 await putSubject(activeWarning,now+60000);await putSubject(activeBlock,0,now+60000);
 await putSubject(settled);await putWaf(settled,0,'confirmed');await db.prepare("INSERT INTO visitor_abuse_audit(id,workspace_id,subject_hash,actor,action,created_at) VALUES('audit-settled',?,?,'owner','owner_unblock',?)").bind(workspace,settled,cutoff-1).run();
 for(const [subject,desired,state,operationId,attention] of unresolved){await putSubject(subject);await putWaf(subject,desired,state,operationId,attention);}

 await store.cleanup();
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM visitor_abuse_subjects WHERE workspace_id=? AND subject_hash=?').bind(workspace,stale).first()).n,0);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM visitor_abuse_audit WHERE workspace_id=? AND subject_hash=?').bind(workspace,stale).first()).n,0);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM visitor_abuse_subjects WHERE workspace_id=? AND subject_hash=?').bind(workspace,settled).first()).n,0);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM visitor_abuse_audit WHERE workspace_id=? AND subject_hash=?').bind(workspace,settled).first()).n,0);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM visitor_abuse_waf WHERE workspace_id=? AND subject_hash=?').bind(workspace,settled).first()).n,0);
 for(const subject of [activeWarning,activeBlock,...unresolved.map(row=>row[0])]){
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM visitor_abuse_subjects WHERE workspace_id=? AND subject_hash=?').bind(workspace,subject).first()).n,1,`subject ${subject.slice(0,4)} remains`);
 }
 for(const [subject] of unresolved)assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM visitor_abuse_waf WHERE workspace_id=? AND subject_hash=?').bind(workspace,subject).first()).n,1,`unresolved WAF row ${subject.slice(0,4)} remains`);
});
