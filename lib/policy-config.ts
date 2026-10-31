export const productionPolicyConfiguration={ownedDomain:process.env.PUBLIC_ORIGIN?new URL(process.env.PUBLIC_ORIGIN).hostname:'',privacyUrl:process.env.PUBLIC_ORIGIN?new URL('/privacy',process.env.PUBLIC_ORIGIN).href:'',termsUrl:process.env.PUBLIC_ORIGIN?new URL('/terms',process.env.PUBLIC_ORIGIN).href:'',termsVerifiedAvailable:false};
// These production URLs are operator setup targets, not proof that private demo
// policies satisfy Google's verified-domain/public policy requirements.

