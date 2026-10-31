import {contactNotificationOwnerRoute} from '../../../../../../lib/contact-admin-server';
export const dynamic='force-dynamic';
export const POST=(request:Request)=>contactNotificationOwnerRoute('dispatch',request);
