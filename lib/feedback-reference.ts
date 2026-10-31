import {z} from 'zod/v3';
import {consentKey} from './purpose-consent-core';
export const FEEDBACK_TIMING_METRIC='experiment_feedback';
export const FEEDBACK_TTL_MS=30*60000;
const schema=z.object({purpose:z.literal('section-feedback-v1'),workspaceId:z.string().min(1).max(100),subjectHash:z.string().regex(/^[0-9a-f]{64}$/),grantRevision:z.number().int().nonnegative(),versionId:z.string().uuid(),compositionId:z.string().uuid(),snapshotHash:z.string().regex(/^[0-9a-f]{64}$/),issuedAt:z.number().int().nonnegative(),expiresAt:z.number().int().positive()}).strict();
export type FeedbackReference=z.infer<typeof schema>;
const encode=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const decode=(value:string)=>Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),char=>char.charCodeAt(0));
async function key(secret:string){if(!consentKey(secret))throw new Error('Feedback unavailable');return crypto.subtle.importKey('raw',Uint8Array.from(atob(secret),char=>char.charCodeAt(0)),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);}
const message=(body:string)=>new TextEncoder().encode('navigation-feedback:v1:'+body);
export async function signFeedbackReference(input:FeedbackReference,secret:string){const payload=schema.parse(input);if(payload.expiresAt<=payload.issuedAt||payload.expiresAt-payload.issuedAt>FEEDBACK_TTL_MS)throw new Error('Invalid feedback window');const body=encode(new TextEncoder().encode(JSON.stringify(payload)));return body+'.'+encode(new Uint8Array(await crypto.subtle.sign('HMAC',await key(secret),message(body))));}
export async function verifyFeedbackReference(value:string,secret:string,workspaceId:string,subjectHash:string,grantRevision:number,now=Date.now()):Promise<FeedbackReference|null>{try{if(value.length>4096)return null;const [body,signature,...rest]=value.split('.');if(rest.length||!body||!signature||!await crypto.subtle.verify('HMAC',await key(secret),decode(signature),message(body)))return null;const payload=schema.parse(JSON.parse(new TextDecoder().decode(decode(body))));return payload.workspaceId===workspaceId&&payload.subjectHash===subjectHash&&payload.grantRevision===grantRevision&&payload.issuedAt<=now&&payload.expiresAt>now&&payload.expiresAt>payload.issuedAt&&payload.expiresAt-payload.issuedAt<=FEEDBACK_TTL_MS?payload:null;}catch{return null;}}
