'use client';
import ConnectedAccountMenu from './connected-account-menu';
export function AdminAccountMenu({onSignIn,signInDisabled=false}:{email?:string;onSignIn?:()=>void;signInDisabled?:boolean}){return <ConnectedAccountMenu explicitAdminEntry={!!onSignIn} onAdminSignIn={onSignIn} adminSignInDisabled={signInDisabled}/>;}
