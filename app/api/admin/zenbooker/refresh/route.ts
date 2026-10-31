import {zenbookerApiOwnerRoute} from '../../../../../lib/zenbooker-api-server';
export const POST=(request:Request)=>zenbookerApiOwnerRoute(request,'refresh');
