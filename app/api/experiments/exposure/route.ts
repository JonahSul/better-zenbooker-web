import {exposureStatus} from '../../../../lib/experiment-runtime';
export async function GET(request:Request){return exposureStatus(request);}
