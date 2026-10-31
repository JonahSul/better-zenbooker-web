import {assertAi,assertModule,moduleStatus,scheduleConfiguration,type ModuleEnv} from './module-config';
import {SupportAdminService} from './support-admin';
import {supportStore,supportProxy} from './support-runtime';
import {sha256} from './admin-auth-core';
export type StandaloneScheduledEvent={scheduledTime:number;cron:string};
export type ScheduledResult={cleanup:'complete'|'unavailable';generation:'disabled'|'unconfigured'|'not_due'|'processed'|'unavailable';published:false};
/** Called only by the privileged Worker scheduled handler. Never expose as an HTTP job endpoint. */
export async function dispatchScheduled(runtime:ModuleEnv,event:StandaloneScheduledEvent):Promise<ScheduledResult>{
 const result:ScheduledResult={cleanup:'unavailable',generation:'disabled',published:false};
 if(!runtime.DB||!runtime.INSTALLATION_ID)return result;
 const store=supportStore(runtime);
 // Revocation/expiry cleanup remains available when optional modules and AI are disabled.
 try{await store.prune();result.cleanup='complete';}catch{/* Retry on a later event; no personal data or exception text leaves this boundary. */}
 try{
  const setting=await moduleStatus(runtime,'schedules');if(!setting.enabled)return result;
  const config=scheduleConfiguration(setting.config);if(!config){result.generation='unconfigured';return result;}
  if(!Number.isSafeInteger(event.scheduledTime)||event.scheduledTime<0||event.scheduledTime>Date.now()+300000||Date.now()-event.scheduledTime>86400000||event.cron!==config.cron){result.generation='not_due';return result;}
  const time=new Date(event.scheduledTime),parts=config.cron.split(' ');if(time.getUTCMinutes()!==Number(parts[0])||time.getUTCHours()!==Number(parts[1])){result.generation='not_due';return result;}
  await assertModule(runtime,'schedules');await assertAi(runtime,'visitor_support');
  // One immutable idempotency key per installation/day even if the event is delivered repeatedly.
  const requestKey='schedule_'+await sha256(runtime.INSTALLATION_ID+':visitor-curation:'+Math.floor(event.scheduledTime/86400000));
  const actor='system:scheduled:'+await sha256(runtime.INSTALLATION_ID);
  const ai=runtime.AI;const scopedRuntime:ModuleEnv={...runtime,AI:ai?{run:async(model,input)=>{await assertModule(runtime,'schedules');return ai.run(model,input);}}:undefined};const proxy=supportProxy(scopedRuntime),request=proxy.request.bind(proxy);
  // Recheck the schedule switch at the final model dispatch, after evidence/budget preparation.
  proxy.request=async(...args)=>{await assertModule(runtime,'schedules');return request(...args);};
  await new SupportAdminService(store,proxy).curate(requestKey,actor);
  result.generation='processed';return result;
 }catch{result.generation='unavailable';return result;}
}
export const runScheduled=dispatchScheduled;
