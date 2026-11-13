4
!function(t){try{var e="undefined"!=typeof window?window:"undefined"!=typeof global?global:"undefined"!=typeof globalThis?globalThis:"undefined"!=typeof self?self:{},n="Error\n    at "+t+":1:1";e._sentryDebugIds=e._sentryDebugIds||{},e._sentryDebugIds[n]="6d19ca08-3740-4ff1-aa8b-50ac3e423c00",e._sentryDebugIdIdentifier="sentry-dbid-6d19ca08-3740-4ff1-aa8b-50ac3e423c00"}catch(e){}}(import.meta.url);
import{an as e}from"./index.eager-common-Cu696cDC.js";import{NO as t}from"./index.eager-app-6K9VF8rg.js";function n(t){let{id:n,label:r}=t;return e._({id:`93GOzw`,values:{label:r,id:n}})}function r(e){return{type:`paragraph`,content:[{type:`text`,text:e}]}}function i(e){let{lead:i,items:a,nudge:o}=e,s={type:`bulletList`,content:a.map(e=>({type:`listItem`,content:[{type:`paragraph`,content:[{type:t,attrs:{id:e.id,label:e.label}}]}]}))},c={type:`doc`,content:[r(i),s,r(o)]};return{prompt:[i,a.map(e=>`- ${n(e)}`).join(`
`),o].join(`

`),richText:JSON.stringify(c)}}export{i as n,n as t};
//# debugId=6d19ca08-3740-4ff1-aa8b-50ac3e423c0