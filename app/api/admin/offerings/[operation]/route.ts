import {offeringsOwnerRoute} from '../../../../../lib/service-offerings-server';
import {safeJson} from '../../../../../lib/admin-auth-server';
export const dynamic='force-dynamic';
export async function POST(request:Request,{params}:{params:Promise<{operation:string}>}){const {operation}=await params;if(operation!=='status'&&operation!=='save_draft'&&operation!=='publish'&&operation!=='withdraw')return safeJson({error:'Service-list action unavailable.'},404);return offeringsOwnerRoute(request,operation);}
