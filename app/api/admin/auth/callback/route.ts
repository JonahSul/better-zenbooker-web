import {adminAuthRoute} from '../../../../../lib/admin-auth-server';
export const dynamic='force-dynamic';
export async function GET(request:Request){return adminAuthRoute('callback',request);}
