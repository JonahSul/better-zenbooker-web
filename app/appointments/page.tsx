import CustomerShell from '../../components/customer-shell';
import HostedAppointmentHelp from '../../components/hosted-appointment-help';
import {pageMetadata} from '../../lib/discovery';
export const dynamic='force-dynamic';
export const metadata=pageMetadata('/appointments','Appointment help | Your business','Use your booking confirmation or contact Your business for appointment help.');
export default function Page(){return <CustomerShell measurementId="appointments_heading" title="A little help with your next visit." eyebrow="Your business / APPOINTMENT HELP"><HostedAppointmentHelp/></CustomerShell>;}
