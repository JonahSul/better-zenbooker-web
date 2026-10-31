import {z} from 'zod/v3';
import {signPurposeProof,verifyPurposeProof} from './consent-proof';
export const ANALYTICS_COOKIE='__Host-analytics_consent';
export const analyticsConsentSchema=z.object({grantId:z.string().uuid(),revision:z.number().int().positive(),granted:z.boolean(),expiresAt:z.number().int().positive()}).strict();
export type AnalyticsConsent=z.infer<typeof analyticsConsentSchema>;
export async function signAnalyticsConsent(value:AnalyticsConsent,secret:string){const payload=analyticsConsentSchema.parse(value);if(payload.expiresAt<=Date.now()||payload.expiresAt>Date.now()+30*86400000)throw new Error('Invalid consent expiry');return signPurposeProof(payload,secret,'analytics-consent:v1');}
export async function verifyAnalyticsConsent(value:string|null|undefined,secret:string|undefined,now=Date.now()):Promise<AnalyticsConsent|null>{const parsed=analyticsConsentSchema.safeParse(await verifyPurposeProof(value,secret,'analytics-consent:v1'));return parsed.success&&parsed.data.expiresAt>now&&parsed.data.expiresAt<=now+30*86400000?parsed.data:null;}
