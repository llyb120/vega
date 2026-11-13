c
!function(t){try{var e="undefined"!=typeof window?window:"undefined"!=typeof global?global:"undefined"!=typeof globalThis?globalThis:"undefined"!=typeof self?self:{},n="Error\n    at "+t+":1:1";e._sentryDebugIds=e._sentryDebugIds||{},e._sentryDebugIds[n]="8ef1e56e-0ce6-4665-87d6-5cb95751fe33",e._sentryDebugIdIdentifier="sentry-dbid-8ef1e56e-0ce6-4665-87d6-5cb95751fe33"}catch(e){}}(import.meta.url);
function e(e,t={}){let n=t.delimiter??`,`,r=t.maxRows??1/0,i=[],a=``,o=[],s=!1,c=!1,l=()=>{o.push(a),a=``},u=()=>{l(),i.push(o),o=[],c=!1};for(let t=0;t<e.length&&!(i.length>=r);t+=1){let r=e[t];s?r===`"`?e[t+1]===`"`?(a+=`"`,t+=1):s=!1:a+=r:r===`"`?(s=!0,c=!0):r===n?(c=!0,l()):r===`
`?u():r===`\r`?(e[t+1]===`
`&&(t+=1),u()):(a+=r,c=!0)}return i.length<r&&(c||a.length>0||o.length>0)&&u(),i}function t(e){let t=0,n=!1,r=!1;for(let i=0;i<e.length;i+=1){let a=e[i];if(a===`"`){if(n&&e[i+1]===`"`){i+=1;continue}n=!n,r=!0}else!n&&(a===`
`||a===`\r`)?(a===`\r`&&e[i+1]===`
`&&(i+=1),t+=1,r=!1):r=!0}return r?t+1:t}function n(e,t=`,`){let n=e.split(/\r?\n/).find(e=>e.length>0)??``,i=[t,`,`,`	`,`;`,`|`],a=t,o=-1;for(let e of i){let t=r(n,e);t>o&&(a=e,o=t)}return o>0?a:t}function r(e,t){let n=0,r=!1;for(let i=0;i<e.length;i+=1){let a=e[i];if(a===`"`){if(r&&e[i+1]===`"`){i+=1;continue}r=!r}else!r&&a===t&&(n+=1)}return n}export{n,e as r,t};
//# debugId=8ef1e56e-0ce6-4665-87d6-5cb95751fe3