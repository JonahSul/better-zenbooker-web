import { googleReviewsCallback } from '../../../../lib/google-reviews-server';
export const dynamic='force-dynamic';
export async function GET(request:Request){return googleReviewsCallback(request);}
