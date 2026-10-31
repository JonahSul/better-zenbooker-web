import {customerGoogleRoute} from '../../../../../lib/customer-google-server';
export const GET=(request:Request)=>customerGoogleRoute('status',request);
