import type {ReactNode} from 'react';
export default function IntentLabel({children,className=''}:{children:ReactNode;className?:string}){return <span className={'intent-label '+className}>{children}</span>;}
