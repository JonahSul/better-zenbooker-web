import type {CustomerAccountStatus,RoleRead} from './account-controller';
export type ProfileFieldState={touched:boolean;auto:null|{epoch:number;name:string|null;email:string;expiresAt:number;value:string}};
export function createProfileFieldState():ProfileFieldState{return {touched:false,auto:null};}
export function editProfileField(state:ProfileFieldState):ProfileFieldState{return {...state,touched:true,auto:null};}
type Input={value:string;autofilled:boolean;kind:'name'|'email';maxLength:number;accept?:(value:string)=>boolean;customer:CustomerAccountStatus;availability:RoleRead['availability'];epoch:number;now:number};
export function reconcileProfileField(state:ProfileFieldState,input:Input):{state:ProfileFieldState;value:string}{
 let next={...state},value=input.value;
 if(next.touched||input.autofilled||next.auto&&value!==next.auto.value||!next.auto&&value!=='')return {state:editProfileField(next),value};
 const profile=input.customer.profile,valid=!!profile&&input.customer.authenticated&&Number.isSafeInteger(input.epoch)&&input.epoch>=0&&Number.isFinite(input.now)&&typeof input.customer.expiresAt==='number'&&Number.isSafeInteger(input.customer.expiresAt)&&input.customer.expiresAt>input.now&&typeof profile.email==='string'&&profile.email.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email)&&input.availability!=='unavailable';
 const name=typeof profile?.name==='string'?profile.name:null;
 if(next.auto&&(!valid||next.auto.epoch!==input.epoch||next.auto.name!==name||next.auto.email!==profile?.email||next.auto.expiresAt!==input.customer.expiresAt)){if(value===next.auto.value)value='';next={...next,auto:null};}
 if(!valid||input.availability!=='ready'||next.auto||value!=='')return {state:next,value};
 const candidate=input.kind==='name'?name:profile!.email;let acceptable=typeof candidate==='string'&&candidate.trim().length>0&&Number.isSafeInteger(input.maxLength)&&input.maxLength>0&&candidate.length<=input.maxLength&&!/[\u0000-\u001f\u007f]/.test(candidate);if(acceptable&&input.accept)try{acceptable=input.accept(candidate!);}catch{acceptable=false;}
 if(acceptable){value=candidate!;next={...next,auto:{epoch:input.epoch,name,email:profile!.email,expiresAt:input.customer.expiresAt!,value}};}
 return {state:next,value};
}
