import {env} from 'cloudflare:workers';
import {CredentialStore} from './credential-store';
import {adminOidcConfig,sha256,type AdminOidcRuntime} from './admin-auth-core';
import {googleConfig,type GoogleRuntime} from './google-reviews-core';

export type SecretRuntime=AdminOidcRuntime&GoogleRuntime&{CLOUDFLARE_WAF_API_TOKEN?:string;VISITOR_ABUSE_RUNNER_KEY?:string;VISITOR_ABUSE_IP_HMAC_KEY?:string;VISITOR_ABUSE_IP_MODE?:string;VISITOR_ABUSE_DIRECT_INGRESS_VERIFIED?:string;VISITOR_ABUSE_WAF_ACCOUNT_ID?:string;VISITOR_ABUSE_WAF_LIST_ID?:string;CUSTOMER_GOOGLE_PREFILL_ENABLED?:string;CUSTOMER_GOOGLE_CLIENT_ID?:string;CUSTOMER_GOOGLE_CLIENT_SECRET?:string;APP_CREDENTIAL_ENCRYPTION_KEY?:string;EXPERIMENT_COOKIE_SIGNING_KEY?:string;SITE_OWNER_USER_ID?:string;GTM_CONTAINER_ID?:string;GA4_PROPERTY_ID?:string;CONTACT_PUBLIC_EMAIL?:string;CONTACT_NOTIFICATION_TO?:string;CONTACT_NOTIFICATION_BCC?:string;CONTACT_NOTIFICATION_SUBJECT_PREFIX?:string;PUBLIC_REVIEWS_URL?:string;TRUSTINDEX_WIDGETS_ENABLED?:string;TRUSTINDEX_BADGE_WIDGET_ID?:string;TRUSTINDEX_LIST_WIDGET_ID?:string;GA4_MEASUREMENT_ID?:string;GA4_MP_API_SECRET?:string;CLOUDFLARE_ACCOUNT_ID?:string;WORKERS_AI_API_TOKEN?:string;WORKERS_AI_MODEL?:string;WORKERS_AI_EMBEDDING_MODEL?:string;VECTORIZE_API_TOKEN?:string;VECTORIZE_INDEX_NAME?:string;ZENBOOKER_API_KEY?:string;CLOUDFLARE_EMAIL_API_TOKEN?:string;CLOUDFLARE_EMAIL_ACCOUNT_ID?:string;HOSTED_BOOKING_BRIDGE_URL?:string;VISITOR_AI_CONTEXT_KEY?:string;VISITOR_AI_PROXY_URL?:string;INSTALLATION_ID?:string;PUBLIC_ORIGIN?:string;ANALYTICS_IMPORT_BINDINGS?:string;OWNER_EMAILS?:string};
export const SITE_PROJECT_ID=(env as unknown as {INSTALLATION_ID?:string}).INSTALLATION_ID??'installation-unconfigured';
export function secretRuntime(){return env as SecretRuntime;}
export function credentialStore(){if(!env.DB)throw new Error('Credential storage unavailable');return new CredentialStore(env.DB,SITE_PROJECT_ID,secretRuntime().APP_CREDENTIAL_ENCRYPTION_KEY);}
export async function resolveAdminOidcConfig(){const runtime=secretRuntime();if(!runtime.ADMIN_GOOGLE_CLIENT_ID?.endsWith('.apps.googleusercontent.com'))return null;let secret=runtime.ADMIN_GOOGLE_CLIENT_SECRET;if(!secret){secret=(await credentialStore().resolve('ADMIN_GOOGLE_CLIENT_SECRET')).value??undefined;}return adminOidcConfig({...runtime,ADMIN_GOOGLE_CLIENT_SECRET:secret});}
export async function adminConfigFingerprint(config:{clientId:string;clientSecret:string}){return sha256('admin-oidc:v1:'+SITE_PROJECT_ID+':'+config.clientId+':'+config.clientSecret);}
export async function resolveGoogleBusinessConfig(){const runtime=secretRuntime();if(!runtime.GOOGLE_BUSINESS_CLIENT_ID?.endsWith('.apps.googleusercontent.com'))return null;let secret=runtime.GOOGLE_BUSINESS_CLIENT_SECRET;if(!secret)secret=(await credentialStore().resolve('GOOGLE_BUSINESS_CLIENT_SECRET')).value??undefined;return googleConfig({...runtime,GOOGLE_BUSINESS_CLIENT_SECRET:secret,GOOGLE_BUSINESS_OWNER_USER_ID:SITE_PROJECT_ID});}
export async function businessConfigFingerprint(config:{clientId:string;clientSecret:string;ownerUserId:string;encryptionKey:string}){return sha256('business-oauth:v1:'+SITE_PROJECT_ID+':'+config.clientId+':'+config.clientSecret+':'+config.ownerUserId+':'+config.encryptionKey);}




