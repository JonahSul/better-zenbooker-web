import {resetGoogleTagIdentityBinding} from './tag-identity-client';
export type ConsentStatus={configured:boolean;analytics:boolean;analyticsSaved:boolean;analyticsSuppressed:boolean;experiments:boolean;analyticsRevision:number;experimentsRevision:number;measurementId:string|null;containerId:string|null;configRevision:number|null};
type Purpose='analytics'|'experiments';
type Intent={id:string;grant:boolean;pending:boolean};
let state:ConsentStatus={configured:false,analytics:false,analyticsSaved:false,analyticsSuppressed:false,experiments:false,analyticsRevision:0,experimentsRevision:0,measurementId:null,containerId:null,configRevision:null};
const configSequences=new WeakMap<object,number>();let configSequence=0,appliedConfigSequence=0;
let ready=false,analyticsEpoch=0,experimentEpoch=0,readSequence=0,started=false;
const denialRecoveries=new Map<Purpose,{id:string;promise:Promise<ConsentStatus>}>();
const listeners=new Set<()=>void>();let channel:BroadcastChannel|null=null;
const intentKey=(purpose:Purpose)=>'functional-consent-intent:'+purpose;
function emit(){for(const listener of listeners)listener();}
function readIntent(purpose:Purpose):Intent|null{try{const value=JSON.parse(localStorage.getItem(intentKey(purpose))??'null');return value&&typeof value.id==='string'&&typeof value.grant==='boolean'&&typeof value.pending==='boolean'?value:null;}catch{return null;}}
function writeIntent(purpose:Purpose,intent:Intent){try{localStorage.setItem(intentKey(purpose),JSON.stringify(intent));return readIntent(purpose)?.id===intent.id;}catch{return false;}}
function blocked(purpose:Purpose){const value=readIntent(purpose);return !!value&&(!value.grant||value.pending);}
export function consentSnapshot(){return state;}
export function pendingPurposeDenial(purpose:Purpose){const value=readIntent(purpose);return !!value&&!value.grant&&value.pending;}
export function subscribePurposeConsent(listener:()=>void){listeners.add(listener);startConsentSync();return ()=>{listeners.delete(listener);};}
export function currentAnalyticsEpoch(){return analyticsEpoch;}
export function analyticsReferenceAllowed(epoch=analyticsEpoch){return ready&&state.analytics&&!state.analyticsSuppressed&&!blocked('analytics')&&epoch===analyticsEpoch;}
export function disablePurposeLocally(purpose:Purpose,broadcast=true){resetGoogleTagIdentityBinding();if(purpose==='analytics'){analyticsEpoch++;state={...state,analytics:false,analyticsSaved:false,measurementId:null,containerId:null,configRevision:null};}else{experimentEpoch++;state={...state,experiments:false,measurementId:null};}emit();if(broadcast)channel?.postMessage({type:'pending',purpose});}
async function readServer(){const sequence=++configSequence;const response=await fetch('/api/consent',{cache:'no-store',signal:AbortSignal.timeout(4000)});if(!response.ok)throw new Error('Consent unavailable');const value=await response.json() as ConsentStatus;configSequences.set(value,sequence);return value;}
function applyServer(value:ConsentStatus,a:number,e:number){const sequence=configSequences.get(value)??0,applyConfig=a===analyticsEpoch&&sequence>=appliedConfigSequence&&(value.configRevision===null||state.configRevision===null||value.configRevision>=state.configRevision);if(applyConfig)appliedConfigSequence=sequence;state={...state,configured:value.configured,analyticsSuppressed:value.analyticsSuppressed,...(applyConfig?{containerId:value.analytics&&!value.analyticsSuppressed&&!blocked('analytics')&&typeof value.containerId==='string'?value.containerId:null,configRevision:value.analytics&&!value.analyticsSuppressed&&!blocked('analytics')&&Number.isSafeInteger(value.configRevision)?value.configRevision:null}:{}),...(a===analyticsEpoch?{analytics:value.analytics&&!blocked('analytics'),analyticsSaved:value.analyticsSaved&&!blocked('analytics'),analyticsRevision:value.analyticsRevision}:{}),...(e===experimentEpoch?{experiments:value.experiments&&!blocked('experiments'),experimentsRevision:value.experimentsRevision}:{}),measurementId:a===analyticsEpoch&&e===experimentEpoch&&!blocked('analytics')&&!blocked('experiments')?value.measurementId:null};ready=true;emit();return state;}
export async function recoverPendingDenial(purpose:Purpose):Promise<ConsentStatus>{
 const intent=readIntent(purpose);
 if(!intent||intent.grant||!intent.pending)return state;
 const existing=denialRecoveries.get(purpose);if(existing?.id===intent.id)return existing.promise;
 disablePurposeLocally(purpose,false);
 const locks=typeof navigator!=='undefined'?navigator.locks:undefined;if(!locks)return state;
 const recover=async()=>{
  const latest=()=>{const current=readIntent(purpose);return current?.id===intent.id&&!current.grant&&current.pending;};
  if(!latest())return state;
  const before=await readServer();if(!latest())return state;
  const expectedPurposeRevision=purpose==='analytics'?before.analyticsRevision:before.experimentsRevision;
  const response=await fetch('/api/consent',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({purpose,grant:false,expectedPurposeRevision})});
  if(!response.ok)throw new Error('Withdrawal not saved');
  await response.json();const a=analyticsEpoch,e=experimentEpoch;const after=await readServer();
  if(!latest())return state;
  const confirmed=purpose==='analytics'?after.analyticsSaved===false&&after.analyticsRevision>expectedPurposeRevision:after.experiments===false&&after.experimentsRevision>expectedPurposeRevision;
  if(!confirmed||!writeIntent(purpose,{...intent,pending:false}))throw new Error('Withdrawal not confirmed');
  const result=applyServer(after,a,e);channel?.postMessage({type:'saved',purpose,grant:false});
  if(purpose==='analytics'&&document.getElementById('optional-gtm'))window.location.reload();
  return result;
 };
 const promise:Promise<ConsentStatus>=(async()=>{try{return await locks.request('optional-purpose-choice:'+purpose,{mode:'exclusive'},recover);}catch{if(readIntent(purpose)?.id===intent.id)disablePurposeLocally(purpose,false);return state;}})();
 denialRecoveries.set(purpose,{id:intent.id,promise});
 try{return await promise;}finally{if(denialRecoveries.get(purpose)?.promise===promise)denialRecoveries.delete(purpose);}
}
export async function refreshPurposeConsent(){const sequence=++readSequence,a=analyticsEpoch,e=experimentEpoch,value=await readServer();if(sequence===readSequence)applyServer(value,a,e);await Promise.all([recoverPendingDenial('analytics'),recoverPendingDenial('experiments')]);return state;}
export async function choosePurposeConsent(purpose:Purpose,grant:boolean){
 startConsentSync();const intent:Intent={id:crypto.randomUUID(),grant,pending:true};
 // This functional latest-intent marker never leaves this browser or becomes an analytics identifier.
 const coordinated=writeIntent(purpose,intent);disablePurposeLocally(purpose);
 const locks=typeof navigator!=='undefined'?navigator.locks:undefined;
 if(grant&&(!coordinated||!locks))throw new Error('Allow unavailable: this browser cannot coordinate privacy choices. Decline remains available.');
 const change=async()=>{
  if(coordinated&&readIntent(purpose)?.id!==intent.id)return state;
  const before=await readServer();
  if(coordinated&&readIntent(purpose)?.id!==intent.id)return state;
  const expectedPurposeRevision=purpose==='analytics'?before.analyticsRevision:before.experimentsRevision;
  // Keep the exclusive lock until the write response AND fresh shared-cookie readback are consumed.
  // No write timeout, Promise.race, automatic Allow replay, or premature lock release.
  const response=await fetch('/api/consent',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({purpose,grant,expectedPurposeRevision})});
  if(!response.ok)throw new Error('Consent changed or unavailable. Refresh and choose again.');
  await response.json();const a=analyticsEpoch,e=experimentEpoch;const after=await readServer();
  if(coordinated&&readIntent(purpose)?.id!==intent.id)return state;
  if(coordinated&&!writeIntent(purpose,{...intent,pending:false}))throw new Error('Consent coordination unavailable. Optional activity remains off.');
  const result=applyServer(after,a,e);channel?.postMessage({type:'saved',purpose,grant});return result;
 };
 return locks?locks.request('optional-purpose-choice:'+purpose,{mode:'exclusive'},change):change();
}
export function startConsentSync(){if(started||typeof window==='undefined')return;started=true;const receive=(value:{type?:string;purpose?:Purpose;grant?:boolean})=>{if(!value||!['analytics','experiments'].includes(value.purpose??''))return;const purpose=value.purpose!;if(value.type==='pending')disablePurposeLocally(purpose,false);if(value.type==='saved'){if(!value.grant&&purpose==='analytics'&&document.getElementById('optional-gtm'))window.location.reload();else void refreshPurposeConsent().catch(()=>{});}};
 if(typeof BroadcastChannel!=='undefined'){channel=new BroadcastChannel('optional-purpose-choices');channel.onmessage=event=>receive(event.data);}
 window.addEventListener('storage',event=>{if(!event.key?.startsWith('functional-consent-intent:'))return;const purpose=event.key.endsWith(':analytics')?'analytics':'experiments';const intent=readIntent(purpose);if(intent?.pending||!intent?.grant)disablePurposeLocally(purpose,false);if(intent&&!intent.pending)receive({type:'saved',purpose,grant:intent.grant});});
 window.addEventListener('focus',()=>{void refreshPurposeConsent().catch(()=>{});});window.addEventListener('pageshow',()=>{void refreshPurposeConsent().catch(()=>{});});
 void Promise.all([recoverPendingDenial('analytics'),recoverPendingDenial('experiments')]);
}
