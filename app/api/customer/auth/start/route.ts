import {customerAuthRoute} from '../../../../../lib/customer-api';
export const POST=(request:Request)=>customerAuthRoute('start',request);
