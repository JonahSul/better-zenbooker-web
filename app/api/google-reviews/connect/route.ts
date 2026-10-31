import { googleReviewsRoute } from '../../../../lib/google-reviews-server';
export const dynamic='force-dynamic';
export async function POST(request:Request){return googleReviewsRoute('connect',request);}
