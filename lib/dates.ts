export function denverToday(now = new Date()): string {const parts=new Intl.DateTimeFormat('en-US',{timeZone:process.env.NEXT_PUBLIC_BUSINESS_TIME_ZONE??'UTC',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);return ['year','month','day'].map(type=>parts.find(p=>p.type===type)!.value).join('-');}
export function nextDenverDate(now=new Date()):string {const day=new Date(denverToday(now)+'T12:00:00Z');day.setUTCDate(day.getUTCDate()+1);return day.toISOString().slice(0,10);}

