import ElementMeasurement from '../components/element-measurement';
import PublicSupportBoundary from '../components/public-support-boundary';
import SensitiveRouteBoundary from '../components/sensitive-route-boundary';
import type { Metadata } from 'next';
import './globals.css';
import { AnalyticsRouteFooter } from '../components/analytics';
import { DEMO_ORIGIN } from '../lib/site-config';
import { pageMetadata } from '../lib/discovery';
export const metadata:Metadata={title:'Business website',description:'Business services and appointments',robots:{index:false,follow:false}};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en"><body><SensitiveRouteBoundary>{children}</SensitiveRouteBoundary><AnalyticsRouteFooter/><PublicSupportBoundary/><ElementMeasurement/></body></html>;}




