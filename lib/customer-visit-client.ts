import type {z} from 'zod/v3';
import type {accountInteractionInput} from './customer-account-core';
export const CURRENT_VISIT_KEY='app:current-visit:v1';
let pending:Promise<void>=Promise.resolve(),generation=0,failedVisitId:string|undefined;
export function awaitCurrentVisit(){return pending;}
type Visit={id:string;startedAt:number;lastActivityAt:number;count:number};
function load(storage:Storage,now:number):Visit|null{try{const raw=storage.getItem(CURRENT_VISIT_KEY);if(!raw||raw.length>300)return null;const v=JSON.parse(raw);return Object.keys(v).sort().join(',')==='count,id,lastActivityAt,startedAt'&&typeof v.id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v.id)&&Number.isSafeInteger(v.startedAt)&&v.startedAt<=now&&v.startedAt>now-7200000&&Number.isSafeInteger(v.lastActivityAt)&&v.lastActivityAt<=now&&v.lastActivityAt>now-1800000&&Number.isInteger(v.count)&&v.count>=0&&v.count<=50?v:null;}catch{return null;}}
export function currentVisitId(){try{const id=load(sessionStorage,Date.now())?.id;return id!==failedVisitId?id:undefined;}catch{return undefined;}}
export function clearCurrentVisit(){generation++;failedVisitId=undefined;try{sessionStorage.removeItem(CURRENT_VISIT_KEY);}catch{}}
type Interaction=z.infer<typeof accountInteractionInput>;
type Event=Interaction extends infer T?T extends Interaction?Omit<T,'visitId'|'requestKey'>:never:never;
export function recordCurrentVisit(event:Event){const epoch=generation;pending=pending.then(async()=>{if(epoch!==generation)return;let id:string|undefined;try{const now=Date.now(),visit=load(sessionStorage,now)??{id:crypto.randomUUID(),startedAt:now,lastActivityAt:now,count:0};id=visit.id;if(visit.count>=50||id===failedVisitId)return;visit.count++;visit.lastActivityAt=now;sessionStorage.setItem(CURRENT_VISIT_KEY,JSON.stringify(visit));const response=await fetch('/api/customer/account/interactions',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({...event,visitId:visit.id,requestKey:crypto.randomUUID()}),signal:AbortSignal.timeout(5000)});if(!response.ok)failedVisitId=id;}catch{failedVisitId=id;}});return pending;}
