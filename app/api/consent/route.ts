import {purposeConsentRoute} from '../../../lib/purpose-consent-server';
export const dynamic='force-dynamic';
export async function GET(request:Request){return purposeConsentRoute(request);}
export async function POST(request:Request){return purposeConsentRoute(request);}
