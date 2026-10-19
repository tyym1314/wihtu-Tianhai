/**
 * Arena UI language. Source strings are the Chinese UI text; en/ar come from DICTIONARY.
 * Locale order: explicit choice stored by the same-origin host page (/launch, /player),
 * then the device language, then Chinese. Safe to import on the server (always zh there).
 */
import DICTIONARY from './i18n-dict.mjs';

export const LOCALES=['zh','en','ar'];
const STORAGE_KEY='oasis-locale';
export function normalizeLocale(value){
 const v=String(value||'').toLowerCase();
 // Players get English or Arabic only (Chinese stays the dictionary source / server language).
 return v.startsWith('ar')?'ar':v?'en':null;
}
function detect(){
 // Node also exposes navigator.language; server and tests always use the source language.
 if(typeof globalThis.document==='undefined')return 'zh';
 try{const saved=normalizeLocale(globalThis.localStorage?.getItem(STORAGE_KEY));if(saved)return saved;}catch{}
 const langs=globalThis.navigator?.languages||[globalThis.navigator?.language];
 for(const l of langs||[]){const n=normalizeLocale(l);if(n)return n;}
 return 'en';
}
let locale=detect();
const listeners=new Set();
export const getLocale=()=>locale;
export const isRtl=()=>locale==='ar';
export function setLocale(next,{persist=true}={}){
 const n=normalizeLocale(next);if(!n)return locale;
 if(persist)try{globalThis.localStorage?.setItem(STORAGE_KEY,n);}catch{}
 if(n!==locale){locale=n;applyDocument();for(const fn of listeners)fn(n);}
 return locale;
}
export function onLocaleChange(fn){listeners.add(fn);return()=>listeners.delete(fn);}
function applyDocument(){const d=globalThis.document?.documentElement;if(d){d.lang=locale==='zh'?'zh-CN':locale;}}
applyDocument();

/** t('剩余 {0} 秒',[n]) — positional values; {{ and }} are literal braces. */
export function t(source,values){
 let text=source;
 if(locale!=='zh'){const entry=DICTIONARY[source];text=entry?(locale==='ar'?entry[1]||entry[0]:entry[0])||source:source;}
 if(values)text=text.replace(/\{(\d+)\}/g,(_,i)=>values[i]??'');
 return text.replace(/\{\{/g,'{').replace(/\}\}/g,'}');
}
/** Localized copy of a shared game definition (shared/games.mjs stays Chinese for the server). */
export function localizeGame(meta){
 if(!meta||locale==='zh')return meta;
 return {...meta,name:t(meta.name),description:t(meta.description),scoreUnit:meta.scoreUnit&&t(meta.scoreUnit),rules:(meta.rules||[]).map(r=>t(r))};
}
