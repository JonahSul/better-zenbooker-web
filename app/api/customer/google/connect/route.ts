import {customerGoogleRoute} from '../../../../../lib/customer-google-server';
export const POST=(request:Request)=>customerGoogleRoute('connect',request);
