import {bookingRoute} from '../../../../lib/booking-api';
export const POST=(request:Request)=>bookingRoute('selection',request);
