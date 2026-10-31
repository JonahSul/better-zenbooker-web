import {customerAccountRoute} from '../../../../../lib/customer-account-server';
export const dynamic='force-dynamic';
export const PUT=(request:Request)=>customerAccountRoute(request,'preferences');
