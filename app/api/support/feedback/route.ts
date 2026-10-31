import {supportApi} from '../../../../lib/support-api';
export const POST=(request:Request)=>supportApi('feedback',request);
