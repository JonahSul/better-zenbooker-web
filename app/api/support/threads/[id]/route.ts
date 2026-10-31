import {supportApi} from '../../../../../lib/support-api';
export async function GET(request:Request,context:{params:Promise<{id:string}>}){return supportApi('thread',request,(await context.params).id);}
export async function DELETE(request:Request,context:{params:Promise<{id:string}>}){return supportApi('thread',request,(await context.params).id);}
