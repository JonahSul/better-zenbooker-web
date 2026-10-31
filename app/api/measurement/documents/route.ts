import {elementDocumentsRoute} from '../../../../lib/element-measurement-server';
export const dynamic='force-dynamic';
export async function POST(request:Request){return elementDocumentsRoute(request);}
