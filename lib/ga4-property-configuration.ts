import {z} from 'zod/v3';
export const validGa4PropertyId=(value:unknown):value is string=>typeof value==='string'&&/^[1-9][0-9]{0,19}$/.test(value);
export const ga4PropertyConfigurationInput=z.object({expectedRevision:z.number().int().min(0),propertyId:z.string().refine(validGa4PropertyId).nullable()}).strict();
export type Ga4PropertyConfiguration={revision:number;propertyId:string|null;source:'persisted'|'native'|'unavailable'};
export const GA4_PROPERTY_SETTINGS_SUBJECT='system:analytics-configuration',GA4_PROPERTY_SETTINGS_KEY='ga4-property-v1';
export class Ga4PropertyConfigurationStore{
 constructor(private db:D1Database,private workspaceId:string,private now:()=>number=Date.now){}
 async read(nativeContainerId?:string):Promise<Ga4PropertyConfiguration>{const row=await this.db.prepare('SELECT value_json,revision FROM admin_settings WHERE workspace_id=? AND google_subject=? AND key=?').bind(this.workspaceId,GA4_PROPERTY_SETTINGS_SUBJECT,GA4_PROPERTY_SETTINGS_KEY).first<{value_json:string;revision:number}>();if(row){let config:{propertyId:string|null}={propertyId:null};try{const value=JSON.parse(row.value_json),parsed=ga4PropertyConfigurationInput.safeParse({expectedRevision:row.revision,propertyId:value.propertyId??null});if(parsed.success)config=parsed.data;}catch{}return {revision:row.revision,propertyId:config.propertyId,source:'persisted'};}const valid=validGa4PropertyId(nativeContainerId);return {revision:0,propertyId:valid?nativeContainerId!:null,source:valid?'native':'unavailable'};}
 async save(value:unknown,actor:string){
  if(typeof actor!=='string'||actor.length<1||actor.length>300||actor!==actor.trim()||/[\r\n\u0000]/.test(actor))throw new Error('audit_actor_required');
  const input=ga4PropertyConfigurationInput.parse(value),writeToken=crypto.randomUUID(),auditId=crypto.randomUUID(),now=this.now(),revision=input.expectedRevision+1,json=JSON.stringify({propertyId:input.propertyId,writeToken});
  const results=await this.db.batch([
   this.db.prepare('INSERT INTO admin_settings(workspace_id,google_subject,key,value_json,revision,updated_at) SELECT ?,?,?,?,1,? WHERE ?=0 OR EXISTS(SELECT 1 FROM admin_settings WHERE workspace_id=? AND google_subject=? AND key=? AND revision=?) ON CONFLICT(workspace_id,google_subject,key) DO UPDATE SET value_json=excluded.value_json,revision=admin_settings.revision+1,updated_at=excluded.updated_at WHERE admin_settings.revision=?').bind(this.workspaceId,GA4_PROPERTY_SETTINGS_SUBJECT,GA4_PROPERTY_SETTINGS_KEY,json,now,input.expectedRevision,this.workspaceId,GA4_PROPERTY_SETTINGS_SUBJECT,GA4_PROPERTY_SETTINGS_KEY,input.expectedRevision,input.expectedRevision),
   this.db.prepare("INSERT INTO admin_audit(id,google_subject,action,target,created_at) SELECT ?,?,'analytics.property_configuration_save',?,? WHERE EXISTS(SELECT 1 FROM admin_settings WHERE workspace_id=? AND google_subject=? AND key=? AND revision=? AND json_extract(value_json,'$.writeToken')=?)").bind(auditId,actor,JSON.stringify({workspaceId:this.workspaceId,revision,propertyId:input.propertyId}),now,this.workspaceId,GA4_PROPERTY_SETTINGS_SUBJECT,GA4_PROPERTY_SETTINGS_KEY,revision,writeToken),
  ]);
  if(!results[0].meta.changes||!results[1].meta.changes)throw new Error('configuration_changed');return {...await this.read(),auditId};
 }
}
