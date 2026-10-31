import {captureElementOutcome} from '../../../lib/element-measurement-server';
import {ELEMENT_DOCUMENT_HEADER} from '../../../lib/element-measurement-core';
import {waitUntil} from 'cloudflare:workers';
import {contactNotificationService} from '../../../lib/contact-notification-server';
import {ContactStore} from '../../../lib/contact-store';
import {SITE_PROJECT_ID} from '../../../lib/runtime-secrets';
import {captureConversion} from '../../../lib/measurement-capture';
import {env} from 'cloudflare:workers';
import {saveInquiryWithConversion} from '../../../lib/inquiry-persistence';
import {inquiryAttribution} from '../../../lib/experiment-runtime';
import {adminGuard} from '../../../lib/admin-auth-server';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { getDb } from '../../../db';
import { inquiries } from '../../../db/schema';
import { inquiryInput, updateInput } from '../../../lib/inquiry-validation';
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'private, no-store'}});
async function readBounded(request:Request,collect:boolean):Promise<Uint8Array|null> {
 const reader=request.body?.getReader();if(!reader)return null;
 let size=0;const chunks:Uint8Array[]=[];
 try {
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>8192){await reader.cancel();throw new Error('invalid');}if(collect)chunks.push(value);}
  if(!collect)return null;
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
 }finally{reader.releaseLock();}
}
async function discardRejectedBody(request:Request){try{await readBounded(request,false);}catch{/* Preserve the original authorization failure on unreadable or oversized bodies. */}}
async function boundedBody(request:Request){const bytes=await readBounded(request,true);if(!bytes||!request.headers.get('content-type')?.startsWith('application/json'))throw new Error('invalid');return JSON.parse(new TextDecoder().decode(bytes));}
export async function GET(request:Request){const denied=await adminGuard(request);if(denied)return denied;try{const rows=await getDb().select().from(inquiries).where(and(eq(inquiries.workspaceId,SITE_PROJECT_ID),isNull(inquiries.deletedAt))).orderBy(desc(inquiries.createdAt)).limit(200);return json({inquiries:rows.map(row=>({id:row.id,name:row.name,contact:row.contact,service:row.service,area:row.area,preferredDate:row.preferredDate,source:row.source,note:row.note,status:row.status,revenueCents:row.revenueCents,createdAt:row.createdAt,updatedAt:row.updatedAt}))});}catch{return json({error:'Inquiries could not be loaded. Please try again.'},503);}}
export async function POST(request:Request){return mutate(request,false);}
export async function PATCH(request:Request){const denied=await adminGuard(request);if(denied)return denied;return mutate(request,true);}
async function mutate(request:Request,update:boolean){
 if(request.headers.get('origin')!==new URL(request.url).origin){await discardRejectedBody(request);return json({error:'This request must come from this site.'},403);}
 let body:unknown;try{body=await boundedBody(request);}catch{return json({error:'Use a valid, short JSON request.'},400);}
 if(update){const parsed=updateInput.safeParse(body);if(!parsed.success)return json({error:'Choose a valid status and nonnegative revenue amount.'},400);try{const {id,...fields}=parsed.data;const rows=await getDb().update(inquiries).set({...fields,updatedAt:Date.now()}).where(and(eq(inquiries.id,id),eq(inquiries.workspaceId,SITE_PROJECT_ID),isNull(inquiries.deletedAt))).returning({id:inquiries.id});return rows.length?json({saved:true}):json({error:'Inquiry not found.'},404);}catch{return json({error:'Changes could not be saved. Please try again.'},503);}}
 const parsed=inquiryInput.safeParse(body);if(!parsed.success)return json({error:'Check your name, email or phone, service, area and date. Keep the note under 1,000 characters.'},400);
 try{if(!env.DB)throw new Error('Storage unavailable');const assignment=await inquiryAttribution(request);let notification;try{notification=await contactNotificationService().eligibility('inquiry.demo_saved');}catch{/* Notification setup does not block the separate demo intake. */}const result=await saveInquiryWithConversion(env.DB,SITE_PROJECT_ID,parsed.data,assignment,notification);if(result.created&&request.headers.has(ELEMENT_DOCUMENT_HEADER))try{waitUntil(captureElementOutcome(request,'demo_request_received',result.id).catch(()=>{}));}catch{/* Optional measurement never changes the durable demo receipt. */}if(result.created&&notification?.policyEligible)try{waitUntil((async()=>{const item=await new ContactStore(env.DB!,SITE_PROJECT_ID).outboxForSource('demo_inquiry',result.id);if(item)await contactNotificationService().dispatchNew({id:item.id,expectedRevision:item.revision},'system:demo-inquiry');})().catch(()=>{}));}catch{/* The separate demo receipt remains durable. */}if(result.created)captureConversion(request,result.id);return json({saved:true,...result},result.created?201:200);}catch{return json({error:'Your request was not saved. Please try again.'},503);}
}






