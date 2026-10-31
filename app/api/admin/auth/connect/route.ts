import {adminAuthRoute} from '../../../../../lib/admin-auth-server';
export const dynamic='force-dynamic';
export async function POST(request:Request){return adminAuthRoute('connect',request);}
