import {customerAccountRoute} from '../../../../../lib/customer-account-server';
export const dynamic='force-dynamic';
export const GET=(request:Request)=>customerAccountRoute(request,'export');
