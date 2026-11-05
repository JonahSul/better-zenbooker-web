import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

export const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export async function createAbuseDb(t){
 const migration=await readFile(path.join(root,'drizzle/0036_visitor_abuse.sql'),'utf8');
 const mf=new Miniflare(convertV4MiniflareOptions({script:'export default {fetch(){return new Response("ok")}}',modules:true,d1Databases:{DB:'visitor-abuse-'+randomUUID()}}));
 t.after(()=>mf.dispose());
 const db=await mf.getD1Database('DB');
 for(const statement of migration.split('--> statement-breakpoint').map(value=>value.trim()).filter(Boolean)) await db.prepare(statement).run();
 await db.prepare('CREATE TABLE app_credentials(project_id TEXT NOT NULL,credential_key TEXT NOT NULL,ciphertext TEXT NOT NULL,PRIMARY KEY(project_id,credential_key))').run();
 return db;
}
