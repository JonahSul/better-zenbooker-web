import {appointmentsRoute} from '../../../../../lib/booking-api';
export async function POST(request:Request,context:{params:Promise<{id:string}>}){return appointmentsRoute('cancel',request,(await context.params).id);}
