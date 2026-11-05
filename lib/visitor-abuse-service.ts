import {env} from 'cloudflare:workers';
import {SITE_PROJECT_ID} from './runtime-secrets';
import {encryptValue,validEncryptionKey} from './encrypted-value';
import {VisitorAbuseStore} from './visitor-abuse-store';
import {abuseHash,abuseToolInput,canonicalIp,directStructuredInjection,redactAbuseEvidence,safeHobby,validOffense,type AbuseNotice} from './visitor-abuse-core';
export type AbuseRuntime={DB?:D1Database;INSTALLATION_ID?:string;VISITOR_ABUSE_IP_HMAC_KEY?:string;APP_CREDENTIAL_ENCRYPTION_KEY?:string;VISITOR_ABUSE_IP_MODE?:string;VISITOR_ABUSE_DIRECT_INGRESS_VERIFIED?:string;VISITOR_ABUSE_WAF_ACCOUNT_ID?:string;VISITOR_ABUSE_WAF_LIST_ID?:string;CLOUDFLARE_WAF_API_TOKEN?:string;VISITOR_ABUSE_RUNNER_KEY?:string;VISITOR_ABUSE_SITE_ORIGIN?:string};
export function abuseRuntime():AbuseRuntime{const runtime=env as unknown as AbuseRuntime;return {
 DB:runtime.DB,
 INSTALLATION_ID:runtime.INSTALLATION_ID??SITE_PROJECT_ID,
 VISITOR_ABUSE_IP_HMAC_KEY:runtime.VISITOR_ABUSE_IP_HMAC_KEY,
 APP_CREDENTIAL_ENCRYPTION_KEY:runtime.APP_CREDENTIAL_ENCRYPTION_KEY,
 VISITOR_ABUSE_IP_MODE:runtime.VISITOR_ABUSE_IP_MODE,
 VISITOR_ABUSE_DIRECT_INGRESS_VERIFIED:runtime.VISITOR_ABUSE_DIRECT_INGRESS_VERIFIED,
 VISITOR_ABUSE_WAF_ACCOUNT_ID:runtime.VISITOR_ABUSE_WAF_ACCOUNT_ID,
 VISITOR_ABUSE_WAF_LIST_ID:runtime.VISITOR_ABUSE_WAF_LIST_ID,
 CLOUDFLARE_WAF_API_TOKEN:runtime.CLOUDFLARE_WAF_API_TOKEN,
 VISITOR_ABUSE_RUNNER_KEY:runtime.VISITOR_ABUSE_RUNNER_KEY,
 VISITOR_ABUSE_SITE_ORIGIN:runtime.VISITOR_ABUSE_SITE_ORIGIN
 };}
export function abuseStore(runtime:AbuseRuntime=abuseRuntime()){if(!runtime.DB||!runtime.INSTALLATION_ID)throw new Error('Abuse storage unavailable');return new VisitorAbuseStore(runtime.DB,runtime.INSTALLATION_ID);}
/** Test/server transport seam only. No production route supplies a resolver until platform ingress enrollment is independently validated. */
export type VerifiedAbuseIngress={verifiedIsolation:true;resolve:(request:Request)=>string|null};
export function trustedCallerIp(request:Request,_runtime:AbuseRuntime,ingress?:VerifiedAbuseIngress){if(!ingress?.verifiedIsolation||request.headers.has('cf-worker')||request.headers.has('cf-ew-via'))return null;const forwarded=canonicalIp(request.headers.get('cf-connecting-ip')??'');if(forwarded==='2a06:98c0:3600::103')return null;const ip=canonicalIp(ingress.resolve(request)??'');return ip&&ip!=='2a06:98c0:3600::103'?ip:null;}
async function identity(request:Request,session:string,runtime:AbuseRuntime,ingress?:VerifiedAbuseIngress){if(!/^[a-zA-Z0-9_-]{16,160}$/.test(session))throw new Error('Current caller session required');const ip=runtime.VISITOR_ABUSE_IP_HMAC_KEY&&validEncryptionKey(runtime.APP_CREDENTIAL_ENCRYPTION_KEY)?trustedCallerIp(request,runtime,ingress):null;return {subject:await abuseHash((ip?'ip:'+ip:'session:'+session)+':'+runtime.INSTALLATION_ID,ip?runtime.VISITOR_ABUSE_IP_HMAC_KEY:undefined),scope:ip?'ip' as const:'session' as const,ip};}
export async function inspectCaller(request:Request,session:string,runtime:AbuseRuntime=abuseRuntime(),ingress?:VerifiedAbuseIngress):Promise<AbuseNotice|null>{const who=await identity(request,session,runtime,ingress);return abuseStore(runtime).blocked(who.subject);}
export async function evaluateAbuseTool(args:{request:Request;session:string;requestKey:string;currentRedactedMessage:string;input:unknown},runtime:AbuseRuntime=abuseRuntime(),ingress?:VerifiedAbuseIngress):Promise<AbuseNotice|null>{const parsed=abuseToolInput.safeParse(args.input);if(!parsed.success||!validOffense(args.currentRedactedMessage,parsed.data)||!/^[a-zA-Z0-9_:-]{16,160}$/.test(args.requestKey))return null;const who=await identity(args.request,args.session,runtime,ingress),store=abuseStore(runtime);const ciphertext=who.ip?await encryptValue(who.ip,'visitor-abuse-ip:v1:'+runtime.INSTALLATION_ID+':'+who.subject,runtime.APP_CREDENTIAL_ENCRYPTION_KEY!):undefined;const notice=await store.offense(who.subject,who.scope,args.requestKey,parsed.data.reason,redactAbuseEvidence(parsed.data.evidence),safeHobby(parsed.data.hobby),parsed.data.reason==='structured_jailbreak'&&directStructuredInjection(args.currentRedactedMessage),ciphertext);return notice;}
export function abuseNoticeAnswer(notice:AbuseNotice){return (notice.action==='warn'?'Warning: keep requests focused on help. Another verified offense will block this session.':notice.scope==='ip'?'Help access from this IP is blocked for 24 hours.':'This help session is blocked for 24 hours.')+' Find a better hobby: '+notice.hobby+'.';}
