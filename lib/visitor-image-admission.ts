import {VISION_MODEL} from './support-photo-core';
import {budgetDigest,verifyBudgetContext,IMAGES_ADMISSION_MODEL,BudgetAdmissionError} from './visitor-budget-core';
import {VisitorImageBudgetStore} from './visitor-budget-store';
import type {BudgetEnvironment} from './visitor-budget-admission';
import type {VisitorImagesBinding} from '../integrations/visitor-ai/worker';
/** Verify the exact binary upload, never a decoded/re-encoded string. */
export async function admittedImages(request:Request,environment:BudgetEnvironment,images:VisitorImagesBinding,operation:'normalize'|'vision'='normalize'){
 if(!environment.GUARD_DB||!environment.VISITOR_AI_CONTEXT_KEY||!environment.VISITOR_AI_INSTALLATION_ID)throw new BudgetAdmissionError('context');
 const reader=request.clone().body?.getReader();if(!reader)throw new BudgetAdmissionError('context');const chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>5*1024*1024){await reader.cancel();throw new BudgetAdmissionError('context');}chunks.push(part.value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 const context=await verifyBudgetContext(request.headers.get('X-Visitor-Admission'),environment.VISITOR_AI_CONTEXT_KEY,bytes,operation==='normalize'?IMAGES_ADMISSION_MODEL:VISION_MODEL,Date.now(),environment.VISITOR_AI_INSTALLATION_ID);
 if(operation==='normalize'?(new URL(request.url).pathname!=='/images/normalize'||!['visitor_images','operator_images'].includes(context.purpose)):(new URL(request.url).pathname!=='/vision'||!['visitor_vision','operator_diagnostic'].includes(context.purpose)))throw new BudgetAdmissionError('context');
 if(context.purpose.startsWith('operator_')){const day=Math.floor(Date.now()/86400000);if(context.securitySubject!==await budgetDigest('operator-security:'+context.installation)||context.session!==await budgetDigest('operator-budget:'+context.installation+':'+day)||context.sessionIssuedAt!==day*86400000||context.sessionExpiresAt!==(day+1)*86400000)throw new BudgetAdmissionError('context');}
 const store=new VisitorImageBudgetStore(environment.GUARD_DB);let dispatched=false;
 async function start(){if(dispatched)return;if(context.expiresAt<=Date.now())throw new BudgetAdmissionError('context');try{await store.prune();await store.reserve(context);if(!await store.dispatch(context))throw new BudgetAdmissionError('replay');dispatched=true;}catch(error){if(error instanceof BudgetAdmissionError)throw error;throw new BudgetAdmissionError('context');}}
 async function invoke<T>(action:()=>Promise<T>){await start();try{return await action();}catch(error){try{await store.finish(context.requestKey,'unknown');}catch{}throw error;}}
 const binding:VisitorImagesBinding={info:stream=>invoke(()=>images.info(stream)),input:stream=>({transform:options=>({output:output=>invoke(()=>images.input(stream).transform(options).output(output))})})};
 return {images:binding,complete:async()=>{if(dispatched)await store.finish(context.requestKey,'complete');}};
}
