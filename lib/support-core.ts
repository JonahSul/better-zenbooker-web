import {abuseToolInput} from './visitor-abuse-core';
import {z} from 'zod/v3';
export const SUPPORT_MODEL='@cf/openai/gpt-oss-20b';
export const SUPPORT_PROXY_ORIGIN='';
export const SUPPORT_BOOKING_URL=process.env.NEXT_PUBLIC_HOSTED_BOOKING_URL??'';
export const supportServices:string[]=[];
export const requestKeySchema=z.string().regex(/^[a-zA-Z0-9_-]{16,80}$/);
export const supportChatInput=z.object({threadId:z.string().uuid().optional(),requestKey:requestKeySchema,message:z.string().trim().min(1).max(4000),attachmentId:z.string().uuid().optional()}).strict();
export const supportPreferenceInput=z.object({revision:z.number().int().min(0),remember:z.boolean(),answerLength:z.enum(['short','standard']),serviceInterests:z.array(z.string().uuid()).max(30)}).strict();
export const supportFeedbackInput=z.object({threadId:z.string().uuid(),turnId:z.string().uuid(),vote:z.enum(['up','down']),reason:z.enum(['unclear','incorrect','unhelpful','other']).optional()}).strict();
export const supportDeleteInput=z.object({revision:z.number().int().min(0)}).strict();
export const supportToolNames=['public_kb.search','own_memory.read','own_memory.update','own_memory.delete','support.escalate','visitor.abuse_report'] as const;
export const modelReplySchema=z.object({answer:z.string().max(8000),toolCalls:z.array(z.object({name:z.enum(supportToolNames),arguments:z.record(z.unknown())}).strict()).max(3)}).strict();
export const supportToolArguments={
 'visitor.abuse_report':abuseToolInput,
 'public_kb.search':z.object({query:z.string().min(1).max(500)}).strict(),
 'own_memory.read':z.object({}).strict(),
 'own_memory.update':supportPreferenceInput,
 'own_memory.delete':z.object({revision:z.number().int().min(0)}).strict(),
 'support.escalate':z.object({reason:z.enum(['self_help_failed','urgent','requested_contact'])}).strict(),
};
export function redactSupportText(text:string){return text.slice(0,16000).replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,'[secret or identifier omitted]').replace(/https?:\/\/[^\s<>]+/gi,'[link omitted]').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[email omitted]').replace(/(?:\+?\d[\d ()+.-]{6,}\d)/g,'[phone or identifier omitted]').replace(/\b(?:Bearer\s+)?[A-Za-z0-9_\-]{32,}\b/g,'[secret or identifier omitted]').replace(/<[^>]*>/g,'');}
export function publicSupportAnswer(text:string){return redactSupportText(text.slice(0,16000).replace(/<script\b[^>]*>[\s\S]*?(?:<\/script\s*>|$)/gi,'').replace(/!?\[([^\]\n]{0,500})\]\([^\n)]{0,4000}\)/g,'$1').replace(/!?\[([^\]\n]{0,500})\]\[[^\]\n]{0,500}\]/g,'$1')).replace(/\b(?:<script|javascript:|data:)/gi,'').slice(0,6000);}
export const SUPPORT_HELP='I can help with service services, service areas and using the hosted booking page. Live booking availability and prices are provided by Zenbooker.';
export function supportActions(contact=false){const actions:{type:'book'|'call',label:string,url:string}[]=[];if(SUPPORT_BOOKING_URL)actions.push({type:'book',label:'Open hosted booking',url:SUPPORT_BOOKING_URL});const phone=process.env.NEXT_PUBLIC_BUSINESS_PHONE;if(contact&&phone&&/^\+?[0-9 ()-]{7,30}$/.test(phone))actions.push({type:'call',label:'Call the business',url:'tel:'+phone.replace(/[^+0-9]/g,'')});return actions;}export function explicitPreferenceIntent(message:string){return !/\b(?:do not|don.t|never|should|could|would|can you tell|what if)\b/i.test(message)&&/\b(?:remember|save|prefer|update my|forget|delete my)\b/i.test(message);}
export function escalationAllowed(message:string,reason:string,selfHelpAttempted:boolean){if(reason==='requested_contact')return /\b(?:call|contact|phone|human|person|speak|talk to)\b/i.test(message);if(reason==='urgent')return /\b(?:urgent|flood|burst|leak|emergency)\b/i.test(message);return reason==='self_help_failed'&&selfHelpAttempted;}
export const kbEditInput=z.object({documentId:z.string().uuid().optional(),revision:z.number().int().min(0),title:z.string().trim().min(3).max(160),body:z.string().trim().min(10).max(6000),source:z.enum(['business_site','owner_reviewed']),sourceUrl:z.string().url().refine(v=>{const u=new URL(v);return u.protocol==='https:'&&!u.username&&!u.password;})}).strict();
export const supportConfigInput=z.object({revision:z.number().int().min(0),enabled:z.boolean(),dailyModelCalls:z.number().int().min(1).max(100)}).strict();
export function normalizeSupportModelResult(value:unknown){const result=z.object({choices:z.array(z.object({message:z.object({content:z.string().nullable().optional(),tool_calls:z.array(z.object({function:z.object({name:z.string(),arguments:z.union([z.string(),z.record(z.unknown())])})})).optional()})})).min(1),usage:z.object({prompt_tokens:z.number().int().min(0).optional(),completion_tokens:z.number().int().min(0).optional(),total_tokens:z.number().int().min(0).optional()}).optional()}).parse(value);const message=result.choices[0].message;const map:Record<string,string>={public_kb_search:'public_kb.search',own_memory_read:'own_memory.read',own_memory_update:'own_memory.update',own_memory_delete:'own_memory.delete',support_escalate:'support.escalate',visitor_abuse_report:'visitor.abuse_report'};return {reply:modelReplySchema.parse({answer:message.content??'',toolCalls:(message.tool_calls??[]).map(call=>({name:map[call.function.name]??call.function.name,arguments:typeof call.function.arguments==='string'?JSON.parse(call.function.arguments):call.function.arguments}))}),usage:result.usage??null};}


