import {appointmentsRoute} from '../../../../../lib/booking-api';
export async function POST(request:Request,context:{params:Promise<{id:string}>}){return appointmentsRoute('reschedule',request,(await context.params).id);}
