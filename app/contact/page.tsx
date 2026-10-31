import CustomerShell from '../../components/customer-shell';
import ContactForm from '../../components/contact-form';
import {pageMetadata} from '../../lib/discovery';
import './contact.css';
export const dynamic='force-dynamic';
export const metadata=pageMetadata('/contact','Contact | Your business','Questions about service care or your booking? Contact the business.');
export default function ContactPage(){return <CustomerShell measurementId="contact_heading" title="A question? Let’s talk." eyebrow="CONTACT Your business"><p className="contact-intro">Find a quick answer below, or send a message to the business.</p><div className="contact-layout"><section className="contact-questions" aria-labelledby="contact-questions-title"><h2 id="contact-questions-title">A few helpful answers</h2><details><summary data-measurement-element="contact_faq_1">How do I book a service?</summary><p>Use our booking page to check the service area and available times.</p><a href="/book" data-measurement-element="contact_book">Book a service ↗</a></details><details><summary data-measurement-element="contact_faq_2">I need help with an existing appointment.</summary><p>Use your booking confirmation for appointment details and available self-service options.</p><a href="/appointments">Appointment help ↗</a></details></section><ContactForm/></div></CustomerShell>;}

