import {supportPhotoRoute} from '../../../../../lib/support-photo-api';
export async function GET(request:Request,context:{params:Promise<{id:string}>}){return supportPhotoRoute(request,(await context.params).id);}
export async function DELETE(request:Request,context:{params:Promise<{id:string}>}){return supportPhotoRoute(request,(await context.params).id);}
