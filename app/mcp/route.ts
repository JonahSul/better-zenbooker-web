import {siteMcpRoute} from '../../lib/site-mcp';
export const dynamic='force-dynamic';
export async function POST(request:Request){return siteMcpRoute(request);}
