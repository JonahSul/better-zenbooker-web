import {contactAdminRoute} from '../../../../../../lib/contact-admin-server';
export const dynamic='force-dynamic';
export const POST=(request:Request)=>contactAdminRoute('delete',request);
