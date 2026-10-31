import {build} from 'vite';
import react from '@vitejs/plugin-react';
import {mkdir,readFile,writeFile,readdir,rm,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve,relative,isAbsolute} from 'node:path';
import {renderToString} from 'react-dom/server';
import {createElement} from 'react';
const root=await realpath(fileURLToPath(new URL('../',import.meta.url)));
const cwd=await realpath(process.cwd());
if((process.platform==='win32'?cwd.toLowerCase():cwd)!==(process.platform==='win32'?root.toLowerCase():root))throw new Error('Run the project build from its actual project root.');
function withinProject(path){const target=resolve(root,path);const rel=relative(root,target);if(!rel||rel.startsWith('..')||isAbsolute(rel))throw new Error('Build target must be inside the project.');return target;}
for(const path of ['public/_islands','.build-runtime/public-compiler','.build-runtime/document-compiler','public/_islands/.vite'])withinProject(path);
await build({configFile:false,plugins:[react()],publicDir:false,build:{outDir:'public/_islands',emptyOutDir:true,manifest:true,rolldownOptions:{input:resolve('client/public-islands.tsx'),output:{entryFileNames:'public-[hash].js',chunkFileNames:'chunk-[hash].js',assetFileNames:'asset-[hash][extname]'}}}});
const manifest=JSON.parse(await readFile('public/_islands/.vite/manifest.json','utf8'));const entry=Object.values(manifest).find(v=>v.isEntry);if(!entry)throw new Error('Missing public entry');
await build({configFile:false,plugins:[react()],publicDir:false,build:{ssr:true,outDir:'.build-runtime/public-compiler',emptyOutDir:true,rolldownOptions:{input:resolve('lib/public-template.tsx'),output:{entryFileNames:'template.mjs'}}}});
const template=await import(pathToFileURL(resolve('.build-runtime/public-compiler/template.mjs')).href+'?build='+Date.now());
const body=renderToString(createElement(template.default));
const files=[];async function walk(dir){for(const item of await readdir(dir,{withFileTypes:true})){const path=dir+'/'+item.name;if(item.name==='.vite')continue;if(item.isDirectory())await walk(path);else files.push([path,createHash('sha256').update(await readFile(path)).digest('hex')]);}}
await walk('public/_islands');files.sort((a,b)=>a[0].localeCompare(b[0]));const assetManifestHash=createHash('sha256').update(JSON.stringify(files)).digest('hex');
const artifact={rendererVersion:'public-v4-m2',assetManifestHash,entry:'/_islands/'+entry.file,styles:(entry.css??[]).map(file=>'/_islands/'+file),body,assets:files};await mkdir('generated',{recursive:true});await writeFile('generated/public-artifacts.json',JSON.stringify(artifact));
await rm(withinProject('public/_islands/.vite'),{recursive:true,force:true});
await build({configFile:false,publicDir:false,build:{ssr:true,outDir:'.build-runtime/document-compiler',emptyOutDir:true,rolldownOptions:{input:resolve('lib/public-compiler.ts'),output:{entryFileNames:'compiler.mjs'}}}});
const compiler=await import(pathToFileURL(resolve('.build-runtime/document-compiler/compiler.mjs')).href+'?build='+Date.now());artifact.baseline=await compiler.compilePublicDocument({},artifact);await writeFile('generated/public-artifacts.json',JSON.stringify(artifact));




