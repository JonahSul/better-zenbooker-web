import {z} from 'zod/v3';
export const CONTACT_RATE_WINDOW_MS=60*60*1000;
export const CONTACT_RATE_LIMIT=100;
export class ContactRateLimitError extends Error{readonly retryAfter:number;constructor(retryAfter:number){super('contact_rate_limited');this.retryAfter=Math.max(1,Math.min(3600,Number.isFinite(retryAfter)?Math.ceil(retryAfter):3600));}}
export const CONTACT_RETENTION_MS=30*24*60*60*1000;
export const contactMessageInput=z.object({requestKey:z.string().uuid(),name:z.string().trim().min(1).max(80).refine(value=>!/[\u0000-\u001f\u007f]/.test(value)),email:z.string().trim().email().max(254),message:z.string().trim().min(1).max(4000).refine(value=>!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))}).strict();
export const contactDeleteInput=z.object({id:z.string().uuid(),expectedRevision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER-1)}).strict();
export const contactStatusInput=contactDeleteInput.extend({status:z.enum(['new','read','archived'])}).strict();
const modelRow=z.object({id:z.string().uuid(),revision:z.number().int().positive(),status:z.enum(['new','read','archived']),createdAt:z.number().int().nonnegative(),expiresAt:z.number().int().positive()});
export function projectContactForModel(rows:readonly unknown[],now:number=Date.now()){const messages=rows.slice(0,100).flatMap(row=>{if(!row||typeof row!=='object'||'deletedAt' in row&&row.deletedAt!=null)return [];const parsed=modelRow.safeParse(row);return parsed.success&&parsed.data.expiresAt>now?[parsed.data]:[];});return {count:messages.length,messages,resultLink:'/admin/inquiries' as const};}
export type ContactNotificationEligibility={eligible:boolean;policyEligible?:boolean;refreshSender?:boolean;attentionReason?:ContactAttentionReason;configRevision:number;configFingerprint:string|null;credentialGeneration:string|null};
export type OutboxState='blocked'|'pending'|'dispatching'|'delivered'|'queued'|'failed'|'unknown'|'canceled';

export type ContactAttentionReason='notifications_off'|'not_ready'|'sender_check_required'|'sender_check_busy'|'sender_check_failed'|'configuration_changed'|'source_unavailable';
