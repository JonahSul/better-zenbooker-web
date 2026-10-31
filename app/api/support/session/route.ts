import {supportApi} from '../../../../lib/support-api';
export const DELETE=(request:Request)=>supportApi('session',request);
