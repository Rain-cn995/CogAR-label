// Runs event handlers without a browser. This does not substitute for browser QA.
import ts from "typescript";
import { readFile } from "node:fs/promises";
const moduleUrl = (text) => `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;
export async function mountPage() {
  const hooksUrl = moduleUrl(`
    const slots=[];let cursor=0;let pending=[];let dirty=true;
    const changed=(a,b)=>!a||!b||a.length!==b.length||a.some((v,i)=>!Object.is(v,b[i]));
    export const begin=()=>{cursor=0;dirty=false;pending=[];};
    export const isDirty=()=>dirty;
    export const runEffects=()=>{for(const effect of pending)effect();};
    export const dispose=()=>{for(const slot of slots)slot?.cleanup?.();};
    export function useState(initial){const i=cursor++;if(!slots[i])slots[i]={value:typeof initial==='function'?initial():initial};return [slots[i].value,(value)=>{const next=typeof value==='function'?value(slots[i].value):value;if(!Object.is(next,slots[i].value)){slots[i].value=next;dirty=true;}}];}
    export function useRef(initial){const i=cursor++;if(!slots[i])slots[i]={current:initial};return slots[i];}
    export function useMemo(fn,deps){const i=cursor++;if(!slots[i]||changed(slots[i].deps,deps))slots[i]={value:fn(),deps};return slots[i].value;}
    export function useEffect(fn,deps){const i=cursor++;if(!slots[i]||changed(slots[i].deps,deps)){const old=slots[i];slots[i]={deps};pending.push(()=>{old?.cleanup?.();slots[i].cleanup=fn();});}}
  `);
  const jsxUrl=moduleUrl(`export const Fragment=Symbol('fragment');export function jsx(type,props,key){return {type,props:props??{},key};}export const jsxs=jsx;`);
  const source=await readFile(new URL("../../app/page.tsx",import.meta.url),"utf8");
  let code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  code=code.replaceAll('from "react"',`from "${hooksUrl}"`).replaceAll('from "react/jsx-runtime"',`from "${jsxUrl}"`)
    .replaceAll('from "./first-action.js"',`from "${new URL('../../app/first-action.js',import.meta.url).href}"`)
    .replaceAll('from "./csv-draft.js"',`from "${new URL('../../app/csv-draft.js',import.meta.url).href}"`);
  const hooks=await import(hooksUrl);const {default:Page}=await import(moduleUrl(code));let tree;
  async function flush(){for(let i=0;i<40;i++){if(hooks.isDirty()){hooks.begin();tree=Page();hooks.runEffects();}await Promise.resolve();if(!hooks.isDirty())return;}throw Error('Component did not settle');}
  await flush();
  const walk=(node)=>Array.isArray(node)?node.flatMap(walk):node&&typeof node==='object'?[node,...walk(node.props?.children)]:[];
  return { flush, nodes:()=>walk(tree), act:async(fn)=>{await fn();await flush();}, dispose:hooks.dispose };
}
export const text=(node)=>Array.isArray(node)?node.map(text).join(''):node&&typeof node==='object'?text(node.props?.children):node===null||node===undefined||typeof node==='boolean'?'':String(node);
