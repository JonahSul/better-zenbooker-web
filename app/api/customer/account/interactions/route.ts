import {customerAccountRoute} from '../../../../../lib/customer-account-server';
export const dynamic='force-dynamic';
export const POST=(request:Request)=>customerAccountRoute(request,'interactions');
