import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const componentPath=path.join(root,'components/ui/dialog.tsx');
const stylesheetPath=path.join(root,'components/ui/dialog.css');
const experimentsPath=path.join(root,'components/experiments-admin.tsx');
const [dialogSource,experimentsSource]=await Promise.all([
  readFile(componentPath,'utf8'),
  readFile(experimentsPath,'utf8'),
]);

function rulesFrom(css){
  const rules=[];
  for(const match of css.replace(/\/\*[\s\S]*?\*\//g,'').matchAll(/([^{}]+)\{([^{}]*)\}/g)){
    const selectors=match[1].trim().split(',').map(value=>value.trim());
    const declarations=Object.fromEntries(match[2].split(';').map(value=>value.trim()).filter(Boolean).map(value=>{
      const index=value.indexOf(':');
      return index<0?['','']:[value.slice(0,index).trim().toLowerCase(),value.slice(index+1).trim().toLowerCase()];
    }).filter(([name])=>name));
    rules.push({selectors,declarations});
  }
  return rules;
}

function requireRule(rules,selector){
  const rule=rules.find(value=>value.selectors.includes(selector));
  assert.ok(rule,`missing CSS rule for ${selector}`);
  return rule.declarations;
}

function slot(name){return `[data-slot="${name}"]`;}

function parseJsx(source,file){
  return ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
}

function jsxName(node){
  const tagName=ts.isJsxElement(node)?node.openingElement.tagName:node?.tagName;
  if(!tagName)return '';
  return ts.isIdentifier(tagName)?tagName.text:tagName.getText();
}

function openingElement(node){
  return ts.isJsxElement(node)?node.openingElement:node;
}

function jsxNodes(rootNode){
  const nodes=[];
  function visit(node){
    if(ts.isJsxElement(node)||ts.isJsxSelfClosingElement(node))nodes.push(node);
    ts.forEachChild(node,visit);
  }
  visit(rootNode);
  return nodes;
}

function attribute(node,name){
  return openingElement(node).attributes.properties.find(value=>ts.isJsxAttribute(value)&&value.name.text===name);
}

function expressionText(attr){
  if(!attr||!attr.initializer)return '';
  return ts.isJsxExpression(attr.initializer)?attr.initializer.expression?.getText()??'':attr.initializer.getText();
}

function textContent(node){
  let value='';
  function visit(child){
    if(ts.isJsxText(child))value+=child.text;
    else if(ts.isJsxElement(child)||ts.isJsxFragment(child))child.children.forEach(visit);
  }
  node.children.forEach(visit);
  return value.replace(/\s+/g,' ').trim();
}

function descendants(node){
  const found=[];
  function visit(child){
    if(ts.isJsxElement(child)||ts.isJsxSelfClosingElement(child))found.push(child);
    ts.forEachChild(child,visit);
  }
  visit(node);
  return found;
}

test('dialog wrapper loads portal-safe styles and has a full-screen overlay below centered bounded scrollable content',async()=>{
  assert.match(dialogSource,/import\s+['"]\.\/dialog\.css['"]/,'dialog styles must be loaded by the shared wrapper');
  const css=await readFile(stylesheetPath,'utf8');
  const rules=rulesFrom(css);
  const overlay=requireRule(rules,slot('dialog-overlay'));
  const content=requireRule(rules,slot('dialog-content'));
  assert.equal(overlay.position,'fixed');
  assert.ok(overlay.inset==='0'||['top','right','bottom','left'].every(side=>overlay[side]==='0'||overlay[side]==='0px'),'overlay must cover every viewport edge');
  assert.equal(content.position,'fixed');
  assert.ok((content.top==='50%'&&content.left==='50%'&&/translate/.test(content.transform??''))||
    (content.inset==='0'&&content.margin==='auto'),'content must be centered in the viewport');
  assert.match(content['max-width']??'',/100(vw|dvw)/,'content width must stay within the viewport');
  assert.match(content['max-height']??'',/100(dvh|vh)/,'content height must stay within the viewport');
  assert.ok(['auto','scroll'].includes(content['overflow-y']),'long dialog content must scroll inside the panel');
  assert.ok(['contain','none'].includes(content['overscroll-behavior']),'panel scrolling must not chain to the page');
  assert.ok(Number(content['z-index'])>Number(overlay['z-index']),'dialog content must paint above its overlay');
  const closeFocus=rules.find(rule=>rule.selectors.some(value=>value.includes(slot('dialog-close'))&&value.includes(':focus-visible')));
  assert.ok(closeFocus,'dialog close control needs a keyboard-visible focus rule');
  assert.ok(closeFocus.declarations.outline&&closeFocus.declarations.outline!=='none'||closeFocus.declarations['box-shadow'],'focus-visible state must be visually distinct');
});

test('create and bulk dialogs are opened by non-mutating controls and keep focus return targets',()=>{
  const source=parseJsx(experimentsSource,experimentsPath);
  const nodes=jsxNodes(source);
  const createOpener=nodes.find(node=>jsxName(node)==='button'&&textContent(node).includes('Create draft'));
  assert.ok(createOpener,'create opener should be present');
  const createOpenHandler=expressionText(attribute(createOpener,'onClick'));
  assert.match(createOpenHandler,/setCreateOpen\(true\)/);
  assert.doesNotMatch(createOpenHandler,/createDraft\(|\bcall\(|experiments\.create/,'opening the dialog must not submit a draft request');
  assert.match(createOpenHandler,/createOpener\.current\s*=\s*event\.currentTarget/,'create dialog should remember its opener for focus return');

  const bulkOpener=nodes.find(node=>jsxName(node)==='button'&&/setBulkAction\(action\)/.test(expressionText(attribute(node,'onClick'))));
  assert.ok(bulkOpener,'bulk action opener should be present');
  const bulkOpenHandler=expressionText(attribute(bulkOpener,'onClick'));
  assert.doesNotMatch(bulkOpenHandler,/\bbulk\(|experiments\.(archive|restore|delete)/,'opening a bulk dialog must not mutate selected versions');
  assert.match(bulkOpenHandler,/bulkOpener\.current\s*=\s*event\.currentTarget/,'bulk dialog should remember its opener for focus return');

  const dialogOpeners=nodes.filter(node=>jsxName(node)==='Dialog');
  assert.ok(dialogOpeners.some(node=>expressionText(attribute(node,'open'))==='createOpen'));
  assert.ok(dialogOpeners.some(node=>expressionText(attribute(node,'open'))==='!!bulkAction'));
  const contentNodes=nodes.filter(node=>jsxName(node)==='DialogContent');
  assert.equal(contentNodes.length,2,'create and bulk dialogs should use the shared portal wrapper');
  for(const content of contentNodes)assert.match(expressionText(attribute(content,'onCloseAutoFocus')),/restoreDialogFocus\(event,/,'closing should return focus to the opener or versions heading');
  assert.match(experimentsSource,/function restoreDialogFocus\(/);
  assert.match(experimentsSource,/requestAnimationFrame\(/,'focus restoration should wait for portal teardown');
  assert.match(experimentsSource,/versionsHeading\.current\s*=|ref=\{versionsHeading\}/,'focus has a connected page-heading fallback if an opener is gone or disabled');
  assert.match(experimentsSource,/target\?\.focus\(\{preventScroll:true\}\)/,'focus return should not unexpectedly scroll the page');
  const bulkConfirmation=descendants(contentNodes[1]).find(node=>jsxName(node)==='button'&&/void bulk\(\)/.test(expressionText(attribute(node,'onClick'))));
  assert.ok(bulkConfirmation,'bulk lifecycle action should run only from its confirmation control');
  assert.ok(descendants(contentNodes[1]).some(node=>jsxName(node)==='p'&&expressionText(attribute(node,'role'))==='"alert"'&&node.getText().includes('bulkError')),'bulk rejection should be visible in its dialog');
});

test('create save is submit-only and retains entered title and error details while pending or rejected',()=>{
  const source=parseJsx(experimentsSource,experimentsPath);
  const nodes=jsxNodes(source);
  const form=nodes.find(node=>jsxName(node)==='form'&&descendants(node).some(child=>jsxName(child)==='input'&&expressionText(attribute(child,'id'))==='"experiment-draft-title"'));
  assert.ok(form,'create form should contain its controlled title input');
  const submit=expressionText(attribute(form,'onSubmit'));
  assert.match(submit,/preventDefault\(\)/);
  assert.match(submit,/createDraft\(\)/);
  assert.ok(submit.indexOf('preventDefault()')<submit.indexOf('createDraft()'),'intercept the native form submit before issuing the save request');
  const titleInput=descendants(form).find(node=>jsxName(node)==='input');
  assert.equal(expressionText(attribute(titleInput,'value')),'title');
  assert.match(expressionText(attribute(titleInput,'onChange')),/setTitle\(event\.target\.value\)/);
  assert.match(expressionText(attribute(titleInput,'onChange')),/setCreateError\(''\)/);
  assert.match(expressionText(attribute(titleInput,'disabled')),/busy/);
  assert.ok(descendants(form).some(node=>jsxName(node)==='p'&&expressionText(attribute(node,'role'))==='"alert"'&&node.getText().includes('createError')),'a rejected save should remain visible in the dialog');
  assert.match(experimentsSource,/createAttempt\.current=\{title:safe,key:crypto\.randomUUID\(\)\}/,'a single pending attempt must keep a stable idempotency key');
  assert.match(experimentsSource,/if\(busyRef\.current\)return/,'double submission must be guarded');
  assert.match(experimentsSource,/setCreateError\(error instanceof Error\?error\.message:'Draft could not be saved\. Your title has been kept\.'/,'a rejected save should preserve useful error detail and the title');
});
