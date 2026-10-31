import CustomerShell from '../../components/customer-shell';
import HostedBookingPanel from '../../components/hosted-booking-panel';
import {pageMetadata} from '../../lib/discovery';
export const dynamic='force-dynamic';
export const metadata=pageMetadata('/book','Book service service | Your business','Choose a service service and check available times.');
export default function Page(){return <CustomerShell measurementId="book_heading" title="A little care. A time that works." eyebrow="Your business / BOOK A SERVICE"><HostedBookingPanel/></CustomerShell>;}
