export const credentialPurposes=[['ADMIN_GOOGLE_CLIENT_SECRET','Google sign-in'],['GOOGLE_BUSINESS_CLIENT_SECRET','Google Business Profile'],['GA4_MP_API_SECRET','Google Analytics measurement'],['WORKERS_AI_API_TOKEN','AI assistance'],['VECTORIZE_API_TOKEN','Knowledge search'],['ZENBOOKER_API_KEY','Zenbooker'],['CLOUDFLARE_EMAIL_API_TOKEN','Email']] as const;
export type CredentialPurpose=typeof credentialPurposes[number][0];
export type CredentialPresence={present:boolean;source:string};
export type CredentialStatus={sealed:boolean;bootstrapOnly:boolean;secureTransport:boolean;canShare:boolean;admin:CredentialPresence;business:CredentialPresence;providers:{key:string;present:boolean;source:string}[];error?:string};
export function credentialPresence(status:CredentialStatus,key:CredentialPurpose){return key==='ADMIN_GOOGLE_CLIENT_SECRET'?status.admin:key==='GOOGLE_BUSINESS_CLIENT_SECRET'?status.business:status.providers.find(row=>row.key===key);}
