import {z} from 'zod/v3';
import {validContainerId} from './analytics-contract';
export const analyticsConfigurationInput=z.object({expectedRevision:z.number().int().min(0),enabled:z.boolean(),containerId:z.string().refine(validContainerId).nullable()}).strict().refine(value=>value.enabled?value.containerId!==null:value.containerId===null);
export type AnalyticsConfiguration={revision:number;enabled:boolean;containerId:string|null;source:'persisted'|'native'|'disabled'};
export const ANALYTICS_SETTINGS_SUBJECT='system:analytics-configuration',ANALYTICS_SETTINGS_KEY='gtm-container-v1';
export class AnalyticsConfigurationStore{
 constructor(private db:D1Database,private workspaceId:string,private now:()=>number=Date.now){}
 async read(nativeContainerId?:string):Promise<AnalyticsConfiguration>{const row=await this.db.prepare('SELECT value_json,revision FROM admin_settings WHERE workspace_id=? AND google_subject=? AND key=?').bind(this.workspaceId,ANALYTICS_SETTINGS_SUBJECT,ANALYTICS_SETTINGS_KEY).first<{value_json:string;revision:number}>();if(row){let config:{enabled:boolean;containerId:string|null}={enabled:false,containerId:null};try{const value=JSON.parse(row.value_json),parsed=analyticsConfigurationInput.safeParse({expectedRevision:row.revision,enabled:value.enabled,containerId:value.containerId});if(parsed.success)config=parsed.data;}catch{}return {revision:row.revision,enabled:config.enabled,containerId:config.containerId,source:'persisted'};}const enabled=typeof nativeContainerId==='string'&&validContainerId(nativeContainerId);return {revision:0,enabled,containerId:enabled?nativeContainerId!:null,source:enabled?'native':'disabled'};}
 async save(value:unknown,actor:string){
  if(typeof actor!=='string'||actor.length<1||actor.length>300||actor!==actor.trim()||/[\r\n\u0000]/.test(actor))throw new Error('audit_actor_required');
  const input=analyticsConfigurationInput.parse(value),writeToken=crypto.randomUUID(),auditId=crypto.randomUUID(),now=this.now(),revision=input.expectedRevision+1,json=JSON.stringify({enabled:input.enabled,containerId:input.containerId,writeToken});
  const results=await this.db.batch([
   this.db.prepare('INSERT INTO admin_settings(workspace_id,google_subject,key,value_json,revision,updated_at) SELECT ?,?,?,?,1,? WHERE ?=0 OR EXISTS(SELECT 1 FROM admin_settings WHERE workspace_id=? AND google_subject=? AND key=? AND revision=?) ON CONFLICT(workspace_id,google_subject,key) DO UPDATE SET value_json=excluded.value_json,revision=admin_settings.revision+1,updated_at=excluded.updated_at WHERE admin_settings.revision=?').bind(this.workspaceId,ANALYTICS_SETTINGS_SUBJECT,ANALYTICS_SETTINGS_KEY,json,now,input.expectedRevision,this.workspaceId,ANALYTICS_SETTINGS_SUBJECT,ANALYTICS_SETTINGS_KEY,input.expectedRevision,input.expectedRevision),
   this.db.prepare("INSERT INTO admin_audit(id,google_subject,action,target,created_at) SELECT ?,?,'analytics.configuration_save',?,? WHERE EXISTS(SELECT 1 FROM admin_settings WHERE workspace_id=? AND google_subject=? AND key=? AND revision=? AND json_extract(value_json,'$.writeToken')=?)").bind(auditId,actor,JSON.stringify({workspaceId:this.workspaceId,revision,enabled:input.enabled,containerId:input.containerId}),now,this.workspaceId,ANALYTICS_SETTINGS_SUBJECT,ANALYTICS_SETTINGS_KEY,revision,writeToken),
  ]);
  if(!results[0].meta.changes||!results[1].meta.changes)throw new Error('configuration_changed');return {...await this.read(),auditId};
 }
}
export function projectAnalyticsConfiguration(config:AnalyticsConfiguration,consent:{analytics:boolean;analyticsSuppressed:boolean}){return consent.analytics&&!consent.analyticsSuppressed?{containerId:config.enabled?config.containerId:null,configRevision:config.revision}:{containerId:null,configRevision:null};}
