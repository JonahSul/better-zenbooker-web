import { publicSitemap } from '../../lib/discovery';
export function GET(){return new Response(publicSitemap(),{headers:{'Content-Type':'application/xml; charset=utf-8','X-Robots-Tag':'noindex, nofollow','Cache-Control':'private, no-store'}});}
