import {appointmentsRoute} from '../../../lib/booking-api';
export const GET=(request:Request)=>appointmentsRoute('list',request);
export const POST=(request:Request)=>appointmentsRoute('create',request);
