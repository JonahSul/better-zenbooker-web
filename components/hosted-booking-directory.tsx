'use client';
import HostedBookingPanel from './hosted-booking-panel';
import {hostedBookingClick} from '../lib/hosted-booking-client';
import {HOSTED_SERVICE_IDS,buildHostedBookingUrl,type HostedHandoffInput} from '../lib/hosted-booking-core';
export function HostedBookingLink({serviceId,placement='booking',children,className}:{serviceId?:typeof HOSTED_SERVICE_IDS[number];placement?:HostedHandoffInput['placement'];children:React.ReactNode;className?:string}){return <a href={buildHostedBookingUrl({serviceId,placement})} onClick={event=>hostedBookingClick(event,{serviceId,placement})} className={className}>{children}</a>;}
export default function HostedBookingDirectory(){return <HostedBookingPanel/>;}
