import {DEMO_ORIGIN} from './site-config';
export const SITE_NAME='Business website';
export function pageMetadata(path:string,title:string,description:string){const url=new URL(path,DEMO_ORIGIN).href;return {title,description,alternates:{canonical:url},openGraph:{title,description,url,siteName:SITE_NAME,type:'website' as const}};}
export const discoveryConfig={sitemapEnabled:false,publicOrigin:'',publicPaths:['/','/privacy']} as const;
export function publicSitemap(){return '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>';}
export const homeStructuredData={'@context':'https://schema.org','@type':'WebSite',name:SITE_NAME,url:DEMO_ORIGIN};
