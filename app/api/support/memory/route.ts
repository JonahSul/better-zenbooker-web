import {supportApi} from '../../../../lib/support-api';
export const GET=(request:Request)=>supportApi('memory',request);
export const PUT=(request:Request)=>supportApi('memory',request);
export const DELETE=(request:Request)=>supportApi('memory',request);
