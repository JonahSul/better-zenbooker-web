// Inference admission is independent of conversation storage and analytics consent.
export const VISITOR_WALLET_MICROS=500000;
export const BUDGET_POLICY_VERSION='visitor-budget-v1';
export type BudgetPurpose='visitor_text'|'visitor_vision'|'operator_diagnostic'|'operator_curation'|'visitor_images'|'operator_images';
export type BudgetSession={securitySubject:string;session:string;sessionIssuedAt:number;sessionExpiresAt:number};
export class BudgetAdmissionError extends Error{constructor(public reason:'wallet'|'global'|'concurrency'|'pricing'|'context'|'replay'='context'){super('Inference admission denied');this.name='BudgetAdmissionError';}}
export type BudgetContext=BudgetSession & {installation:string;version:1;policy:string;session:string;requestKey:string;purpose:BudgetPurpose;model:string;bodyDigest:string;issuedAt:number;expiresAt:number};
const encoder=new TextEncoder();
export async function budgetDigest(value:string|Uint8Array){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',typeof value==='string'?encoder.encode(value):new Uint8Array(value).buffer)),b=>b.toString(16).padStart(2,'0')).join('');}
function canonical(c:BudgetContext){return JSON.stringify([c.version,c.installation,c.policy,c.securitySubject,c.session,c.sessionIssuedAt,c.sessionExpiresAt,c.requestKey,c.purpose,c.model,c.bodyDigest,c.issuedAt,c.expiresAt]);}
async function key(secret:string){if(secret.length<32)throw new Error('Admission unavailable');return crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);}
export async function signBudgetContext(context:BudgetContext,secret:string){const signature=await crypto.subtle.sign('HMAC',await key(secret),encoder.encode(canonical(context)));return btoa(JSON.stringify(context))+'.'+Array.from(new Uint8Array(signature),b=>b.toString(16).padStart(2,'0')).join('');}
export async function verifyBudgetContext(token:string|null,secret:string,body:string|Uint8Array,model:string,now=Date.now(),installation?:string):Promise<BudgetContext>{
 if(!token||token.length>4096)throw new Error('Admission required');const [payload,mac,...extra]=token.split('.');if(extra.length||!/^[a-f0-9]{64}$/.test(mac??''))throw new Error('Admission invalid');
 const c=JSON.parse(atob(payload)) as BudgetContext;
 if(Object.keys(c).sort().join(',')!=='bodyDigest,expiresAt,installation,issuedAt,model,policy,purpose,requestKey,securitySubject,session,sessionExpiresAt,sessionIssuedAt,version'||c.version!==1||typeof c.installation!=='string'||c.installation.length<1||c.installation.length>128||(installation!==undefined&&c.installation!==installation)||c.policy!==BUDGET_POLICY_VERSION||!['visitor_text','visitor_vision','operator_diagnostic','operator_curation','visitor_images','operator_images'].includes(c.purpose)||!/^[a-f0-9]{64}$/.test(c.securitySubject)||!/^([a-f0-9]{64})$/.test(c.session)||!/^[a-f0-9-]{36}$/.test(c.requestKey)||c.model!==model||!Number.isSafeInteger(c.issuedAt)||!Number.isSafeInteger(c.expiresAt)||c.issuedAt>now+5000||c.expiresAt<=now||c.expiresAt-c.issuedAt>60000||c.expiresAt<=c.issuedAt||!Number.isSafeInteger(c.sessionIssuedAt)||!Number.isSafeInteger(c.sessionExpiresAt)||c.sessionExpiresAt-c.sessionIssuedAt!==86400000||c.sessionIssuedAt>now||c.sessionExpiresAt<=now||c.expiresAt>c.sessionExpiresAt||c.bodyDigest!==await budgetDigest(body))throw new Error('Admission invalid');
 const bytes=Uint8Array.from(mac.match(/../g)!,s=>parseInt(s,16));if(!await crypto.subtle.verify('HMAC',await key(secret),bytes,encoder.encode(canonical(c))))throw new Error('Admission invalid');return c;
}
export type BudgetPricing={reviewedUntil:string;outputBoundVerified:string};
// Full advertised context is reserved, never a bytes/4 estimate. Category neurons
// round upward independently, then each neuron costs exactly 11 USD micros.
export const IMAGES_ADMISSION_MODEL='images-normalize-v1';
export const INFERENCE_PRICING={
 '@cf/openai/gpt-oss-20b':{inputTokens:128000,outputTokens:128000,inputNeuronsPerMillion:18182,outputNeuronsPerMillion:27273},
 '@cf/moondream/moondream3.1-9B-A2B':{inputTokens:32768,outputTokens:32768,inputNeuronsPerMillion:27273,outputNeuronsPerMillion:90909},
} as const;
export function worstCaseMicros(model:string,policy:BudgetPricing,now=Date.now()){
 if(policy.outputBoundVerified!=='true'||!Number.isFinite(Date.parse(policy.reviewedUntil))||Date.parse(policy.reviewedUntil)<=now||!Object.hasOwn(INFERENCE_PRICING,model))throw new BudgetAdmissionError('pricing');
 const price=INFERENCE_PRICING[model as keyof typeof INFERENCE_PRICING];
 const base=(Math.ceil(price.inputTokens*price.inputNeuronsPerMillion/1000000)+Math.ceil(price.outputTokens*price.outputNeuronsPerMillion/1000000))*11;
 return base+Math.ceil(base/100); // integer USD micros, including a one-percent upward margin
}

export async function signBudgetSession(session:BudgetSession,secret:string){const body=JSON.stringify(session),signature=await crypto.subtle.sign('HMAC',await key(secret),encoder.encode('session:'+body));return btoa(body)+'.'+Array.from(new Uint8Array(signature),b=>b.toString(16).padStart(2,'0')).join('');}
export async function verifyBudgetSession(token:string,secret:string,now=Date.now()):Promise<BudgetSession>{if(token.length>1024)throw new BudgetAdmissionError();const [body,mac,...extra]=token.split('.');if(extra.length||!/^[a-f0-9]{64}$/.test(mac??''))throw new BudgetAdmissionError();const raw=atob(body),value=JSON.parse(raw) as BudgetSession;if(Object.keys(value).sort().join(',')!=='securitySubject,session,sessionExpiresAt,sessionIssuedAt'||!/^[a-f0-9]{64}$/.test(value.securitySubject)||!/^[a-f0-9]{64}$/.test(value.session)||!Number.isSafeInteger(value.sessionIssuedAt)||!Number.isSafeInteger(value.sessionExpiresAt)||value.sessionExpiresAt-value.sessionIssuedAt!==86400000||value.sessionIssuedAt>now||value.sessionExpiresAt<=now)throw new BudgetAdmissionError();if(!await crypto.subtle.verify('HMAC',await key(secret),Uint8Array.from(mac.match(/../g)!,s=>parseInt(s,16)),encoder.encode('session:'+raw)))throw new BudgetAdmissionError();return value;}

export type SecuritySubject={subject:string;issuedAt:number;expiresAt:number};
export async function budgetHmac(value:string,secret:string){return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',await key(secret),encoder.encode(value))),b=>b.toString(16).padStart(2,'0')).join('');}
export async function signSecuritySubject(value:SecuritySubject,secret:string){const body=JSON.stringify(value);return btoa(body)+'.'+await budgetHmac('security:'+body,secret);}
export async function verifySecuritySubject(token:string,secret:string,now=Date.now()):Promise<SecuritySubject>{if(token.length>1024)throw new BudgetAdmissionError();const [body,mac,...extra]=token.split('.');if(extra.length||!/^[a-f0-9]{64}$/.test(mac??''))throw new BudgetAdmissionError();const raw=atob(body),value=JSON.parse(raw) as SecuritySubject;if(Object.keys(value).sort().join(',')!=='expiresAt,issuedAt,subject'||!/^[a-f0-9]{64}$/.test(value.subject)||!Number.isSafeInteger(value.issuedAt)||!Number.isSafeInteger(value.expiresAt)||value.expiresAt-value.issuedAt!==7*86400000||value.issuedAt>now||value.expiresAt<=now)throw new BudgetAdmissionError();if(!await crypto.subtle.verify('HMAC',await key(secret),Uint8Array.from(mac.match(/../g)!,s=>parseInt(s,16)),encoder.encode('security:'+raw)))throw new BudgetAdmissionError();return value;}
