import {bookingRoute} from '../../../../lib/booking-api';
export const GET=(request:Request)=>bookingRoute('catalog',request);
