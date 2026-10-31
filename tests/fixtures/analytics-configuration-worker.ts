import {AnalyticsConfigurationStore} from '../../lib/analytics-configuration';
import {ConsoleStore} from '../../lib/console-store';

interface Env {
  DB: D1Database;
  QA_TOKEN: string;
  QA_WORKSPACE_ID: string;
}

const NATIVE_CONTAINER_ID='GTM-NATIVE123';
const SETTING_SUBJECT='system:analytics-configuration';
const SETTING_KEY='gtm-container-v1';
const FIXTURE_ACTOR='verified-google-subject-fixture';
const FIXTURE_PERSONAL_SUBJECT='analytics-config-admin-fixture';
const FIXTURE_NATIVE_ACTOR=`native-owner:${'a'.repeat(64)}`;

function json(value:unknown,status=200){return Response.json(value,{status,headers:{'Cache-Control':'no-store'}});}

export default {
  async fetch(request:Request,env:Env){
    if(request.headers.get('authorization')!==`Bearer ${env.QA_TOKEN}`)return json({error:'unauthorized'},401);
    const url=new URL(request.url),store=new AnalyticsConfigurationStore(env.DB,env.QA_WORKSPACE_ID);
    if(request.method==='GET'&&url.pathname==='/__qa/state'){
      const [config,row,audits,stored]=await Promise.all([
        store.read(NATIVE_CONTAINER_ID),
        env.DB.prepare('SELECT COUNT(*) AS count FROM admin_settings WHERE workspace_id=? AND google_subject=? AND key=?').bind(env.QA_WORKSPACE_ID,SETTING_SUBJECT,SETTING_KEY).first<{count:number}>(),
        env.DB.prepare("SELECT id,google_subject,action,target,created_at FROM admin_audit WHERE action='analytics.configuration_save' ORDER BY created_at,id").all<{id:string;google_subject:string;action:string;target:string;created_at:number}>(),
        env.DB.prepare('SELECT value_json FROM admin_settings WHERE workspace_id=? AND google_subject=? AND key=?').bind(env.QA_WORKSPACE_ID,SETTING_SUBJECT,SETTING_KEY).first<{value_json:string}>(),
      ]);
      return json({config,rowCount:row?.count??0,audits:audits.results??[],storedValueJson:stored?.value_json??null});
    }
    if(request.method==='POST'&&url.pathname==='/__qa/arm-audit-failure'){
      await env.DB.prepare("CREATE TRIGGER IF NOT EXISTS qa_fail_analytics_configuration_audit BEFORE INSERT ON admin_audit WHEN NEW.action='analytics.configuration_save' BEGIN SELECT RAISE(ABORT,'synthetic analytics audit failure'); END").run();
      return json({armed:true});
    }
    if(request.method==='POST'&&url.pathname==='/__qa/seed-audit-visibility'){
      const target=(workspaceId:string,extra=false)=>JSON.stringify({workspaceId,revision:7,enabled:true,containerId:'GTM-PQ3SVPTK',...(extra?{privateTargetSentinel:'must not escape'}:{})});
      const rows=[
        ['f0000000-0000-4000-8000-000000000001',FIXTURE_PERSONAL_SUBJECT,'profile.updated','personal-target-preserved',10],
        ['f0000000-0000-4000-8000-000000000002',FIXTURE_PERSONAL_SUBJECT,'analytics.configuration_save',target(env.QA_WORKSPACE_ID),20],
        ['f0000000-0000-4000-8000-000000000003',FIXTURE_NATIVE_ACTOR,'analytics.configuration_save',target(env.QA_WORKSPACE_ID,true),30],
        ['f0000000-0000-4000-8000-000000000004',FIXTURE_NATIVE_ACTOR,'analytics.configuration_save',target('foreign-workspace-fixture'),40],
        ['f0000000-0000-4000-8000-000000000005',FIXTURE_NATIVE_ACTOR,'private.native.setting','native-private-sentinel',50],
        ['f0000000-0000-4000-8000-000000000006',FIXTURE_NATIVE_ACTOR,'analytics.configuration_save','{',60],
        ['f0000000-0000-4000-8000-000000000007','foreign-subject-fixture','private.personal.action','foreign-personal-sentinel',70],
      ] as const;
      await env.DB.batch(rows.map(([id,subject,action,target,createdAt])=>env.DB.prepare('INSERT INTO admin_audit(id,google_subject,action,target,created_at) VALUES(?,?,?,?,?)').bind(id,subject,action,target,createdAt)));
      return json({seeded:rows.length});
    }
    if(request.method==='GET'&&url.pathname==='/__qa/audit-list'){
      const store=new ConsoleStore(env.DB,env.QA_WORKSPACE_ID,FIXTURE_PERSONAL_SUBJECT,'synthetic-site-owner');
      return json(await store.audit());
    }
    if(request.method==='POST'&&url.pathname==='/__qa/save'){
      let input:unknown;
      try{input=await request.json();}catch{return json({error:'invalid_input'},400);}
      try{return json(await store.save(input,FIXTURE_ACTOR));}
      catch(error){return json({error:error instanceof Error&&error.message==='configuration_changed'?'configuration_changed':'invalid_input'},error instanceof Error&&error.message==='configuration_changed'?409:400);}
    }
    return json({error:'not_found'},404);
  },
};

