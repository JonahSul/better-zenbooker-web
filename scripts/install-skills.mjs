import {mkdtemp,writeFile,mkdir,cp,readFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
const revision='1a33048817d06df12882cb881dfc754e7039954a';
const root=process.cwd(),destination=resolve(root,'.agents/upstream/cloudflare-skills');
try{await access(destination);const provenance=JSON.parse(await readFile(join(destination,'PROVENANCE.json'),'utf8'));if(provenance.revision!==revision)throw new Error('Existing skills pin differs; reconcile before replacing it.');for(const name of ['cloudflare','workers-best-practices','wrangler','agents-sdk','durable-objects'])await access(resolve(root,'.agents/skills',name,'SKILL.md'));console.log('Pinned official skills already installed and verified.');process.exit(0);}catch(e){if(e.code!=='ENOENT')throw e;}
const temp=await mkdtemp(join(tmpdir(),'better-zenbooker-skills-'));const archive=join(temp,'skills.tar.gz');
const response=await fetch(`https://github.com/cloudflare/skills/archive/${revision}.tar.gz`,{signal:AbortSignal.timeout(60000)});if(!response.ok)throw new Error('Pinned skill archive unavailable');await writeFile(archive,new Uint8Array(await response.arrayBuffer()));
const listing=spawnSync('tar',['-tzf',archive],{encoding:'utf8'});if(listing.status!==0)throw new Error('Cannot inspect skill archive');for(const name of listing.stdout.split('\n').filter(Boolean)){if(name.startsWith('/')||name.split('/').includes('..')||name.includes('\\'))throw new Error('Unsafe archive path');}
await mkdir(destination,{recursive:true});const extraction=spawnSync('tar',['-xzf',archive,'--strip-components=1','-C',destination],{stdio:'inherit'});if(extraction.status!==0)throw new Error('Skill extraction failed');
for(const name of ['cloudflare','workers-best-practices','wrangler','agents-sdk','durable-objects']){const target=resolve(root,'.agents/skills',name);try{await access(target);throw new Error('Skill destination exists: '+name);}catch(e){if(e.code!=='ENOENT')throw e;}await cp(join(destination,'skills',name),target,{recursive:true,errorOnExist:true});}
await writeFile(join(destination,'PROVENANCE.json'),JSON.stringify({repository:'https://github.com/cloudflare/skills',revision,archive:`https://github.com/cloudflare/skills/archive/${revision}.tar.gz`},null,2));
console.log('Installed pinned official Cloudflare skills and complete upstream references in '+destination);

