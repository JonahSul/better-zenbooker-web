import {experimentFeedback} from '../../../../lib/experiment-runtime';
export async function POST(request:Request){return experimentFeedback(request);}
