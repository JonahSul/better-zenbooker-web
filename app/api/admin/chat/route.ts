import {adminChatRoute} from '../../../../lib/chat-server';
export async function POST(request:Request){return adminChatRoute(request);}
