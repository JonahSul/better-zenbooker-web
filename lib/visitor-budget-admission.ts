import {budgetDigest,BudgetAdmissionError,verifyBudgetContext,worstCaseMicros,type BudgetPricing} from './visitor-budget-core';
import {VisitorBudgetStore} from './visitor-budget-store';
export type BudgetEnvironment={VISITOR_AI_INSTALLATION_ID?:string;GUARD_DB?:D1Database;VISITOR_AI_CONTEXT_KEY?:string;VISITOR_AI_POLICY_REVIEWED_UNTIL?:string;VISITOR_AI_OUTPUT_BOUND_VERIFIED?:string};
export async function admittedBinding(request:Request,environment:BudgetEnvironment,ai:{run:(model:string,input:unknown)=>Promise<unknown>},model:string){
 if(!['@cf/openai/gpt-oss-20b','@cf/moondream/moondream3.1-9B-A2B'].includes(model))throw new BudgetAdmissionError('pricing');
 if(!environment.GUARD_DB||!environment.VISITOR_AI_CONTEXT_KEY||!environment.VISITOR_AI_INSTALLATION_ID)throw new Error('Admission unavailable');
 const reader=request.clone().body?.getReader();if(!reader)throw new Error('Admission body required');let size=0;const chunks:Uint8Array[]=[];try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>1400100){await reader.cancel();throw new Error('Admission body limit');}chunks.push(part.value);}}finally{reader.releaseLock();}const all=new Uint8Array(size);let at=0;for(const chunk of chunks){all.set(chunk,at);at+=chunk.length;}const body=new TextDecoder('utf-8',{fatal:true}).decode(all);
 const context=await verifyBudgetContext(request.headers.get('X-Visitor-Admission'),environment.VISITOR_AI_CONTEXT_KEY,body,model,Date.now(),environment.VISITOR_AI_INSTALLATION_ID);
 const path=new URL(request.url).pathname;if(!['/vision','/diagnostic','/infer'].includes(path))throw new BudgetAdmissionError('context');if(context.purpose.startsWith('operator_')){const day=Math.floor(Date.now()/86400000);if(context.securitySubject!==await budgetDigest('operator-security:'+context.installation)||context.session!==await budgetDigest('operator-budget:'+context.installation+':'+day)||context.sessionIssuedAt!==day*86400000||context.sessionExpiresAt!==(day+1)*86400000)throw new BudgetAdmissionError('context');}
 if(path==='/vision'&&!['visitor_vision','operator_diagnostic'].includes(context.purpose)||path==='/diagnostic'&&context.purpose!=='operator_diagnostic'||path==='/infer'&&!['visitor_text','operator_curation'].includes(context.purpose))throw new Error('Admission purpose mismatch');
 const pricing:BudgetPricing={reviewedUntil:environment.VISITOR_AI_POLICY_REVIEWED_UNTIL??'',outputBoundVerified:environment.VISITOR_AI_OUTPUT_BOUND_VERIFIED??''};
 let cost:number;try{cost=worstCaseMicros(model,pricing);}catch{throw new BudgetAdmissionError('pricing');}const store=new VisitorBudgetStore(environment.GUARD_DB);
 return {run:async(actualModel:string,input:unknown)=>{
  if(actualModel!==model)throw new BudgetAdmissionError('pricing');
  if(context.expiresAt<=Date.now())throw new BudgetAdmissionError('context');try{if(worstCaseMicros(model,pricing)!==cost)throw new Error();}catch{throw new BudgetAdmissionError('pricing');}
  try{await store.prune();await store.reserve(context,cost);if(!await store.dispatch(context.requestKey))throw new BudgetAdmissionError('replay');}catch(error){if(error instanceof BudgetAdmissionError)throw error;throw new BudgetAdmissionError('context');}
  try{const result=await ai.run(actualModel,input);await store.finish(context.requestKey,'complete');return result;}catch(error){try{await store.finish(context.requestKey,'unknown');}catch{}throw error;}
 }};
}
