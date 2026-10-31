import {contactAdminRoute} from '../../../../../lib/contact-admin-server';
export const dynamic='force-dynamic';
export const GET=(request:Request)=>contactAdminRoute('list',request);
