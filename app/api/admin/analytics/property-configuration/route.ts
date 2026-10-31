import {ga4PropertyConfigurationOwnerRoute} from '../../../../../lib/ga4-property-configuration-server';
export const dynamic='force-dynamic';
export async function GET(request:Request){return ga4PropertyConfigurationOwnerRoute(request);}
export async function POST(request:Request){return ga4PropertyConfigurationOwnerRoute(request);}
