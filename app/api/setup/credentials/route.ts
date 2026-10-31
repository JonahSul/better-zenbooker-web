import {credentialRoute} from '../../../../lib/credential-server';
export const dynamic='force-dynamic';
export async function GET(request:Request){return credentialRoute(request);}
export async function POST(request:Request){return credentialRoute(request);}
