import {appointmentsRoute} from '../../../../lib/booking-api';
export async function GET(request:Request,context:{params:Promise<{id:string}>}){return appointmentsRoute('read',request,(await context.params).id);}
