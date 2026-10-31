import {canonicalAction} from './action-approval-core';
import {sha256} from './admin-auth-core';
import {managementMutation,managementExport,type ManagementAction,type ManagementTarget} from './experiment-management-core';
import type {ResourceRevision} from './action-approval-core';

// Shared by the atomic claim and the UI eligibility projection. History is never removed.
export const unusedDraftSql=`v.stage='draft'
 AND NOT EXISTS(SELECT 1 FROM exp_compositions c WHERE c.version_id=v.id AND c.snapshot_hash IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM exp_audit history WHERE history.target=v.id AND history.action IN('compile','start','promote'))
 AND NOT EXISTS(SELECT 1 FROM exp_versions child WHERE child.source_version=v.id)
 AND NOT EXISTS(SELECT 1 FROM exp_assignments a WHERE a.version_id=v.id)
 AND NOT EXISTS(SELECT 1 FROM exp_exposures e WHERE e.version_id=v.id)
 AND NOT EXISTS(SELECT 1 FROM exp_conversions x WHERE x.version_id=v.id)
 AND NOT EXISTS(SELECT 1 FROM exp_feedback f WHERE f.version_id=v.id)
 AND NOT EXISTS(SELECT 1 FROM analysis_runs r WHERE r.version_id=v.id)
 AND NOT EXISTS(SELECT 1 FROM analysis_recommendations r WHERE r.version_id=v.id OR r.accepted_version_id=v.id)
 AND NOT EXISTS(SELECT 1 FROM booking_experiment_conversions b WHERE b.version_id=v.id)
 AND NOT EXISTS(SELECT 1 FROM hosted_handoffs h WHERE h.version_id=v.id)
 AND NOT EXISTS(SELECT 1 FROM hosted_booking_references h WHERE h.version_id=v.id)`;
export const inactiveVersionSql=`NOT EXISTS(SELECT 1 FROM exp_runtime r WHERE r.active_version_id=v.id)`;
type ManagedRow={id:string;title:string;stage:string;revision:number;source_version:string|null;created_at:number;managementRevision:number;archivedAt:number|null;deletedAt:number|null};
export class ExperimentManagementStore{
 constructor(public db:D1Database){}
 statement(sql:string,...values:unknown[]){return this.db.prepare(sql).bind(...values);}
 async targets(targets:ManagementTarget[]){const json=JSON.stringify(targets);const rows=(await this.statement(`SELECT v.*,m.revision AS managementRevision,m.archived_at AS archivedAt,m.deleted_at AS deletedAt FROM exp_versions v JOIN exp_version_management m ON m.version_id=v.id JOIN json_each(?) t ON json_extract(t.value,'$.versionId')=v.id WHERE m.revision=json_extract(t.value,'$.managementRevision') AND m.deleted_at IS NULL ORDER BY v.id`,json).all<ManagedRow>()).results;if(rows.length!==targets.length)throw new Error('Selection changed. Refresh and retry.');return rows;}
 async revision(targets:ManagementTarget[]){const rows=await this.targets(targets);return sha256(canonicalAction(rows.map(row=>({versionId:row.id,managementRevision:row.managementRevision,versionRevision:row.revision,stage:row.stage,archivedAt:row.archivedAt,deletedAt:row.deletedAt}))));}
 async mutate(subject:string,action:ManagementAction,input:unknown,approved?:ResourceRevision){const parsed=managementMutation.parse(input);const targets=[...parsed.targets].sort((a,b)=>a.versionId.localeCompare(b.versionId));const json=JSON.stringify(targets);const argsHash=await sha256(canonicalAction({action,targets}));const id=crypto.randomUUID(),now=Date.now();
  const expected=approved?targets.map(target=>({versionId:target.versionId,revision:approved['definition_'+target.versionId]})):[];
  if(approved&&expected.some(target=>typeof target.revision!=='number'))throw new Error('Approved selection changed');
  const approvalGuard=approved?` AND COALESCE((SELECT revision FROM exp_runtime WHERE id=1),0)=? AND NOT EXISTS(SELECT 1 FROM json_each(?) a LEFT JOIN exp_versions x ON x.id=json_extract(a.value,'$.versionId') WHERE x.id IS NULL OR x.revision!=json_extract(a.value,'$.revision'))`:'';
  const eligible=action==='restore'?`m.archived_at IS NOT NULL AND v.stage IN('draft','paused')`:action==='archive'?`m.archived_at IS NULL AND v.stage IN('draft','paused') AND ${inactiveVersionSql}`:`${unusedDraftSql} AND ${inactiveVersionSql}`;
  const result={operation:action,versions:targets.map(target=>({versionId:target.versionId,managementRevision:target.managementRevision+1})),deduplicated:false};
  const batch=await this.db.batch([
   this.statement(`INSERT OR IGNORE INTO exp_management_operations(id,subject,request_key,action,args_hash,result_json,created_at) SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM json_each(?))=(SELECT COUNT(*) FROM json_each(?) t JOIN exp_versions v ON v.id=json_extract(t.value,'$.versionId') JOIN exp_version_management m ON m.version_id=v.id WHERE m.revision=json_extract(t.value,'$.managementRevision') AND m.deleted_at IS NULL AND ${eligible})${approvalGuard}`,id,subject,parsed.requestKey,action,argsHash,JSON.stringify(result),now,json,json,...(approved?[approved.runtimeRevision??-1,JSON.stringify(expected)]:[])),
   this.statement(`UPDATE exp_version_management SET revision=revision+1,archived_at=CASE WHEN ?='archive' THEN ? WHEN ?='restore' THEN NULL ELSE archived_at END,deleted_at=CASE WHEN ?='delete' THEN ? ELSE deleted_at END WHERE version_id IN(SELECT json_extract(value,'$.versionId') FROM json_each(?)) AND EXISTS(SELECT 1 FROM exp_management_operations WHERE id=?)`,action,now,action,action,now,json,id),
   this.statement(`INSERT INTO exp_audit(id,subject,action,target,rationale,created_at) SELECT ?,?,?,?,'',? WHERE EXISTS(SELECT 1 FROM exp_management_operations WHERE id=?)`,id,subject,action,JSON.stringify(targets.map(target=>target.versionId)),now,id)
  ]);
  if(batch[0].meta.changes)return result;
  const previous=await this.statement('SELECT action,args_hash,result_json FROM exp_management_operations WHERE subject=? AND request_key=?',subject,parsed.requestKey).first<{action:string;args_hash:string;result_json:string}>();
  if(previous?.action===action&&previous.args_hash===argsHash)return {...JSON.parse(previous.result_json),deduplicated:true};
  throw new Error('Selection changed or contains an ineligible version. Refresh and retry.');
 }
 async export(input:unknown){const {targets}=managementExport.parse(input);const json=JSON.stringify(targets);const outcomes=await this.db.batch([
  this.statement(`SELECT v.id,v.title,v.stage,v.revision,v.created_at,v.source_version,m.revision AS managementRevision,m.archived_at AS archivedAt,m.deleted_at AS deletedAt FROM exp_versions v JOIN exp_version_management m ON m.version_id=v.id JOIN json_each(?) t ON json_extract(t.value,'$.versionId')=v.id WHERE m.revision=json_extract(t.value,'$.managementRevision') AND m.deleted_at IS NULL ORDER BY v.created_at DESC,v.id`,json),
  this.statement(`SELECT c.version_id,c.label,c.allocation,c.definition_json FROM exp_compositions c JOIN json_each(?) t ON c.version_id=json_extract(t.value,'$.versionId') ORDER BY c.label`,json),
  this.statement(`SELECT v.id,(SELECT COUNT(*) FROM exp_exposures e WHERE e.version_id=v.id) AS exposures,(SELECT COUNT(DISTINCT x.subject_hash) FROM exp_conversions x WHERE x.version_id=v.id) AS convertedSubjects,(SELECT COUNT(*) FROM exp_conversions x WHERE x.version_id=v.id) AS savedRequests,(SELECT COUNT(*) FROM exp_feedback f WHERE f.version_id=v.id AND vote=1) AS thumbsUp,(SELECT COUNT(*) FROM exp_feedback f WHERE f.version_id=v.id AND vote=-1) AS thumbsDown FROM exp_versions v JOIN json_each(?) t ON v.id=json_extract(t.value,'$.versionId')`,json)
 ]);
 const versions=outcomes[0].results as ManagedRow[];if(versions.length!==targets.length)throw new Error('Selection changed. Refresh and retry.');
 const compositions=outcomes[1].results as {version_id:string;label:string;allocation:number;definition_json:string}[];const metrics=outcomes[2].results as {id:string;exposures:number;convertedSubjects:number;savedRequests:number;thumbsUp:number;thumbsDown:number}[];
 return {schemaVersion:1,exportedAt:new Date().toISOString(),versions:versions.map(v=>{const evidence=metrics.find(row=>row.id===v.id)!;return {id:v.id,title:v.title,stage:v.stage,revision:v.revision,createdAt:v.created_at,sourceVersion:v.source_version,management:{revision:v.managementRevision,archivedAt:v.archivedAt,deletedAt:v.deletedAt},compositions:compositions.filter(c=>c.version_id===v.id).map(c=>({label:c.label,allocation:c.allocation,definition:JSON.parse(c.definition_json)})),aggregateEvidence:{exposures:evidence.exposures,convertedSubjects:evidence.convertedSubjects,savedRequests:evidence.savedRequests,thumbsUp:evidence.thumbsUp,thumbsDown:evidence.thumbsDown}};})};
 }
}
