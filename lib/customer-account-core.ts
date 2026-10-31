import {z} from 'zod/v3';
import {sha256} from './admin-auth-core';
const requestKey=z.string().uuid(),expectedRevision=z.number().int().min(0);
export const accountPreferenceInput=z.object({expectedRevision,requestKey,remember:z.boolean(),answerLength:z.enum(['short','standard']),serviceInterests:z.array(z.string().uuid()).max(30)}).strict().refine(value=>new Set(value.serviceInterests).size===value.serviceInterests.length);
export const accountForgetInput=z.object({expectedRevision,requestKey}).strict();
export const accountInteractionInput=z.discriminatedUnion('event',[
 z.object({visitId:z.string().uuid(),requestKey,event:z.literal('service_selected'),offeringId:z.string().uuid(),offeringsRevision:z.number().int().min(0)}).strict(),
 z.object({visitId:z.string().uuid(),requestKey,event:z.literal('booking_opened'),context:z.enum(['book','support-booking'])}).strict(),
 z.object({visitId:z.string().uuid(),requestKey,event:z.literal('help_thread_started'),threadId:z.string().uuid(),threadRevision:z.number().int().min(0)}).strict(),
]);
export type CustomerAccountIdentity={subjectKey:string;sessionHash:string;googleSubject:string;fingerprint:string};
export const DEFAULT_ACCOUNT_PREFERENCES={remember:false,answerLength:'standard' as const,serviceInterests:[] as string[]};
export function accountInteractionReference(event:string,value:unknown){const schema=event==='service_selected'?z.object({offeringId:z.string().uuid(),offeringsRevision:z.number().int().min(0)}):event==='booking_opened'?z.object({context:z.enum(['book','support-booking'])}):event==='help_thread_started'?z.object({threadId:z.string().uuid(),threadRevision:z.number().int().min(0)}):null;if(!schema)return null;const result=schema.safeParse(value);return result.success?result.data:null;}
export async function customerAccountSubjectKey(workspaceId:string,issuer:string,subject:string){if(issuer!=='https://accounts.google.com'||!subject||subject.length>255)throw new Error('identity_unavailable');return sha256('customer-account:v1:'+workspaceId+':'+issuer+':'+subject);}

