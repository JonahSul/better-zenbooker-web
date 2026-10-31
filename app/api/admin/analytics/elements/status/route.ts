import {elementMeasurementOwnerRoute} from '../../../../../../lib/element-measurement-server';
export const dynamic='force-dynamic';
export async function GET(request:Request){return elementMeasurementOwnerRoute(request,'status');}
