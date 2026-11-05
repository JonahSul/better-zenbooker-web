import {currentAbuseSession} from './support-api';
import {inspectCaller} from './visitor-abuse-service';
import {safeJson} from './admin-auth-server';
export async function visitorAbuseStatus(request:Request){try{const session=await currentAbuseSession(request);return safeJson({moderation:session?await inspectCaller(request,session):null});}catch{return safeJson({error:'Status unavailable'},503);}}
