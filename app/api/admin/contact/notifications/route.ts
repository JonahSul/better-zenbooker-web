import {contactNotificationOwnerRoute} from '../../../../../lib/contact-admin-server';
export const dynamic='force-dynamic';
export const GET=(request:Request)=>contactNotificationOwnerRoute('status',request);
