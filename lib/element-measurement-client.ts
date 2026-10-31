import {elementEventInput,type ElementId,type ElementEvent} from './element-measurement-core';
export function createElementObservationController(driver:{now:()=>number;setTimer:(callback:()=>void,delay:number)=>unknown;clearTimer:(timer:unknown)=>void;emit:(events:ElementEvent[])=>void}){
 let granted=false,visible=true,disposed=false,revoked=false;
 const ratios=new Map<ElementId,number>(),timers=new Map<ElementId,{handle:unknown;started:number}>(),sent=new Set<string>();
 function cancel(id:ElementId){const timer=timers.get(id);if(timer)driver.clearTimer(timer.handle);timers.delete(id);}
 function reset(){for(const id of timers.keys())cancel(id);}
 function emit(id:ElementId,kind:ElementEvent['kind']){if(!granted||!visible||disposed||revoked||sent.has(id+':'+kind))return;const parsed=elementEventInput.safeParse({elementId:id,kind});if(!parsed.success)return;sent.add(id+':'+kind);driver.emit([parsed.data]);}
 function start(id:ElementId){if(!granted||!visible||disposed||revoked||sent.has(id+':view')||timers.has(id)||(ratios.get(id)??0)<.5)return;const started=driver.now();const handle=driver.setTimer(()=>{timers.delete(id);if(driver.now()-started>=1000&&(ratios.get(id)??0)>=.5)emit(id,'view');},1000);timers.set(id,{handle,started});}
 return {
  observe(id:ElementId,ratio:number){if(disposed||revoked||!granted||!elementEventInput.safeParse({elementId:id,kind:'view'}).success)return;ratios.set(id,Number.isFinite(ratio)?Math.min(1,Math.max(0,ratio)):0);if(ratio<.5)cancel(id);else start(id);},
  setVisible(value:boolean){if(disposed)return;visible=value;reset();if(visible)for(const id of ratios.keys())start(id);},
  setGranted(value:boolean){if(disposed||revoked)return;if(granted&&!value)revoked=true;granted=value&&!revoked;reset();ratios.clear();},
  action(id:ElementId){emit(id,'action');},
  dispose(){disposed=true;granted=false;reset();ratios.clear();}
 };
}
