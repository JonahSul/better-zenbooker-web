export type ComposerState={threadId:string|null;draft:string;history:string[];recallIndex:number|null;unsentDraft:string;submission:{requestKey:string;text:string;attachmentId:string|null}|null};
export type ComposerEvent={type:'edit';text:string}|{type:'submit';requestKey:string;attachmentId?:string}|{type:'result';requestKey:string;status:'success'|'pending'|'error'|'unknown'}|{type:'recall';direction:'up'|'down'}|{type:'reset';threadId:string|null};
export function createComposerState(threadId:string|null=null):ComposerState{return {threadId,draft:'',history:[],recallIndex:null,unsentDraft:'',submission:null};}
export function composerReducer(state:ComposerState,event:ComposerEvent):ComposerState{
 if(event.type==='reset')return createComposerState(event.threadId);
 if(event.type==='edit')return {...state,draft:event.text,recallIndex:null,unsentDraft:''};
 if(event.type==='submit')return state.submission||!state.draft.trim()?state:{...state,submission:{requestKey:event.requestKey,text:state.draft.trim(),attachmentId:event.attachmentId??null},recallIndex:null};
 if(event.type==='result'){if(!state.submission||state.submission.requestKey!==event.requestKey||event.status!=='success')return state;return {...state,draft:state.draft.trim()===state.submission.text?'':state.draft,history:[...state.history,state.submission.text].slice(-50),submission:null,recallIndex:null,unsentDraft:''};}
 if(!state.history.length||state.submission)return state;
 if(event.direction==='up'){const index=state.recallIndex===null?state.history.length-1:Math.max(0,state.recallIndex-1);return {...state,draft:state.history[index],recallIndex:index,unsentDraft:state.recallIndex===null?state.draft:state.unsentDraft};}
 if(state.recallIndex===null)return state;
 const index=state.recallIndex+1;
 return index>=state.history.length?{...state,draft:state.unsentDraft,recallIndex:null,unsentDraft:''}:{...state,draft:state.history[index],recallIndex:index};
}
export function canRecallComposerKey(input:{key:string;text:string;selectionStart:number;selectionEnd:number;isComposing:boolean;altKey:boolean;ctrlKey:boolean;metaKey:boolean;shiftKey:boolean}):boolean{return !input.isComposing&&!input.altKey&&!input.ctrlKey&&!input.metaKey&&!input.shiftKey&&!/[\r\n]/.test(input.text)&&input.selectionStart===input.selectionEnd&&(input.key==='ArrowUp'&&input.selectionStart===0||input.key==='ArrowDown'&&input.selectionStart===input.text.length);}
export function canSubmitComposerKey(input:{key:string;isComposing:boolean;keyCode:number;altKey:boolean;ctrlKey:boolean;metaKey:boolean;shiftKey:boolean}){return input.key==='Enter'&&!input.isComposing&&input.keyCode!==229&&!input.altKey&&!input.ctrlKey&&!input.metaKey&&!input.shiftKey;}
export function restoreComposerFocus(control:{isConnected:boolean;disabled?:boolean;getClientRects?:()=>{length:number};focus:()=>void}|null,schedule:(callback:()=>void)=>unknown){schedule(()=>{if(control?.isConnected&&!control.disabled&&(!control.getClientRects||control.getClientRects().length>0))control.focus();});}
