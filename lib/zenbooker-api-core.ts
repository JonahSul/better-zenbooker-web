import {z} from 'zod/v3';
import {ZenbookerClient,ProviderError} from './zenbooker-core';
import {inspectRejectedResponse,type ProviderDiagnostic} from './zenbooker-provider-diagnostic';

const requestKey=z.string().uuid();
const utc=z.string().datetime().refine(value=>value.endsWith('Z'));
export const apiWindowSchema=z.object({from:utc,to:utc}).strict().refine(value=>Date.parse(value.to)>Date.parse(value.from)&&Date.parse(value.to)-Date.parse(value.from)<=31*86400000);
export const apiCheckInputSchema=z.object({requestKey}).strict();
export const apiRefreshInputSchema=z.union([
 z.object({action:z.literal('start'),requestKey,resource:z.enum(['services','jobs']),window:apiWindowSchema.optional()}).strict().refine(value=>value.resource==='jobs'?!!value.window:!value.window),
 z.object({action:z.literal('continue'),requestKey,runId:z.string().uuid(),expectedRunRevision:z.number().int().positive()}).strict(),
]);
export type ApiResource='services'|'jobs';
export type ApiWindow=z.infer<typeof apiWindowSchema>;
export type ApiObservation={id:string;name:string;visible:boolean|null};
export type ApiPage={schemaStatus:'validated'|'unverified';count:number;hasMore:boolean;nextCursor:string|null;fieldTypes:Record<string,string>;observations:ApiObservation[]};
export type ApiShapeDiagnostic={stage:'envelope_validation'|'pagination_validation';code:'invalid_response';fieldTypes:Record<string,string>};
export class ApiDiagnosticError extends ProviderError{constructor(public diagnostic:ApiShapeDiagnostic){super('invalid_response');}}
export class ApiHttpDiagnosticError extends ProviderError{constructor(status:number|undefined,public providerDiagnostic:ProviderDiagnostic){super('http_rejected',status);}}
const cursor=z.string().max(16).regex(/^(0|[1-9]\d*)$/).refine(value=>Number.isSafeInteger(Number(value)));
const envelope=z.object({results:z.array(z.unknown()).max(100),count:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),has_more:z.boolean(),next_cursor:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable()});
const service=z.object({service_id:z.string().min(1).max(150).regex(/^[a-zA-Z0-9_-]+$/),name:z.string().min(1).max(300),is_visible:z.boolean().optional()});
function kind(value:unknown):string{return value===undefined?'missing':value===null?'null':Array.isArray(value)?'array':['object','string','number','boolean'].includes(typeof value)?typeof value:'missing';}
function field(rows:unknown[],key:string){const kinds=new Set(rows.map(row=>{let value:unknown=row;for(const segment of key.split('.'))value=value&&typeof value==='object'&&!Array.isArray(value)?(value as Record<string,unknown>)[segment]:undefined;return kind(value);}));return kinds.size===0?'missing':kinds.size===1?[...kinds][0]:'mixed';}
export function projectApiFieldTypes(value:unknown):Record<string,string>{const root=value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};const types:Record<string,string>={root:kind(value)};for(const key of ['results','count','cursor','has_more','next_cursor'])types[key]=kind(root[key]);const rows=Array.isArray(root.results)?root.results.slice(0,100):[];for(const key of ['service_id','name','is_visible','id','job_id','status','created','canceled','timezone','start_date','end_date','start_time','end_time','services','timeslot','timeslot.start','timeslot.end','timeslot.type'])types['results[].'+key]=field(rows,key);return types;}
export function inspectApiPage(resource:ApiResource,value:unknown):ApiPage{
 if(resource!=='services'&&resource!=='jobs')throw new ProviderError('invalid_response');
 const fieldTypes=projectApiFieldTypes(value),parsed=envelope.safeParse(value);if(!parsed.success)throw new ApiDiagnosticError({stage:'envelope_validation',code:'invalid_response',fieldTypes});const data=parsed.data;
 if(data.count!==data.results.length||data.has_more&&data.next_cursor===null)throw new ApiDiagnosticError({stage:'pagination_validation',code:'invalid_response',fieldTypes});
 const services=z.array(service).safeParse(data.results);
 const valid=resource==='services'&&services.success&&new Set(services.data.map(row=>row.service_id)).size===services.data.length;
 return {schemaStatus:valid?'validated':'unverified',count:data.results.length,hasMore:data.has_more,nextCursor:data.next_cursor===undefined||data.next_cursor===null?null:String(data.next_cursor),fieldTypes,observations:valid&&services.success?services.data.map(row=>({id:row.service_id,name:row.name,visible:row.is_visible??null})):[]};
}
export class ZenbookerApiClient{
 constructor(private key:string|undefined,private fetcher:typeof fetch=fetch,private options:{rejectedResponseDiagnostics?:boolean}={}){}
 async page(resource:ApiResource,input:{cursor?:string;limit?:number;window?:ApiWindow;mode?:'discovery'}={}){
  if(resource!=='services'&&resource!=='jobs'||input.mode!==undefined&&input.mode!=='discovery'||resource==='services'&&input.mode!==undefined)throw new ProviderError('invalid_response');
  const current=cursor.safeParse(input.cursor??'0'),limit=input.limit??100;
  if(!current.success||!Number.isInteger(limit)||limit<1||limit>100)throw new ProviderError('invalid_response');
  const query=new URLSearchParams({cursor:String(current.data),limit:String(limit)});
  if(resource==='jobs'){const window=apiWindowSchema.safeParse(input.window);if(!window.success)throw new ProviderError('invalid_response');if(input.mode==='discovery'){query.set('created_after',window.data.from);query.set('created_before',window.data.to);query.set('sort_by','creation_date');}else{query.set('start_date_min',window.data.from);query.set('start_date_max',window.data.to);query.set('sort_by','start_time');}}else if(input.window)throw new ProviderError('invalid_response');
  let providerDiagnostic:ProviderDiagnostic|undefined;const fetcher:typeof fetch=async(url,init)=>{const headers=new Headers(init?.headers);if(init?.method==='GET')headers.set('Content-Type','application/json');const response=await this.fetcher(url,{...init,headers});if(this.options.rejectedResponseDiagnostics&&init?.method==='GET'&&(response.status<200||response.status>=300)){try{providerDiagnostic=await inspectRejectedResponse(response);}catch{providerDiagnostic=undefined;}if(response.status>=200&&response.status<=599)return new Response(null,{status:response.status});}return response;};
  let response:{status:number;data:unknown};try{response=await new ZenbookerClient(this.key,fetcher).request('/'+resource+'?'+query,'GET');}catch(error){if(error instanceof ProviderError&&error.code==='http_rejected'&&providerDiagnostic)throw new ApiHttpDiagnosticError(error.status,providerDiagnostic);throw error;}
  const page=inspectApiPage(resource,response.data);if(page.count>limit)throw new ApiDiagnosticError({stage:'pagination_validation',code:'invalid_response',fieldTypes:page.fieldTypes});return page;
 }
}
