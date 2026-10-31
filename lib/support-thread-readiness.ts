type ThreadReference={id:string;revision:number;expires_at:number;serverLoaded?:boolean;deleted_at?:number|null};
function valid(value:ThreadReference|null|undefined,now:number){return !!value&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.id)&&Number.isSafeInteger(value.revision)&&value.revision>=0&&Number.isSafeInteger(value.expires_at)&&value.expires_at>now&&(value.deleted_at===undefined||value.deleted_at===null);}
export function isReadySupportThread(value:ThreadReference|null|undefined,now=Date.now()){return valid(value,now)&&value!.serverLoaded===true;}
// Call only after the owned thread endpoint succeeds; the expected ID must match that request.
export function confirmSupportThread<T extends ThreadReference>(value:T,expectedId:string,now=Date.now()){if(!valid(value,now)||value.id!==expectedId)throw new Error('Conversation unavailable');return {...value,serverLoaded:true as const};}
