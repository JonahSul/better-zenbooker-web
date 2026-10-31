import {prepareCustomerReschedule} from '../../../../../lib/booking-api';
export async function POST(request:Request,context:{params:Promise<{id:string}>}){return prepareCustomerReschedule(request,(await context.params).id);}
