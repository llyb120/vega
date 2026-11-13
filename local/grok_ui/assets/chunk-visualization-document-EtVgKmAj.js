e
!function(t){try{var e="undefined"!=typeof window?window:"undefined"!=typeof global?global:"undefined"!=typeof globalThis?globalThis:"undefined"!=typeof self?self:{},n="Error\n    at "+t+":1:1";e._sentryDebugIds=e._sentryDebugIds||{},e._sentryDebugIds[n]="741a8a5b-d23e-48b6-b267-2baed54a3671",e._sentryDebugIdIdentifier="sentry-dbid-741a8a5b-d23e-48b6-b267-2baed54a3671"}catch(e){}}(import.meta.url);
import{M as e,j as t,vt as n,yt as r}from"./index.eager-platform-RJXLWBaV.js";import{Vt as i,in as a}from"./index.eager-common-Cu696cDC.js";import{Df as o,Ef as s,Of as c,Ws as l,z_ as u}from"./index.eager-app-6K9VF8rg.js";var d=`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; object-src 'none'; worker-src 'none'; media-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'`,ee=1500,f=1e3,p=2e3,m={name:`start`,ms:1e4},h={name:`settle`,ms:ee},te={kind:`loading`,errors:[],isOnScreen:!1};function g(e){return e.kind!==`console`}function _(e,t){return{kind:`settled`,outcome:`failed`,failure:e,errors:t}}function v(e){let t=e.findLast(g);return t===void 0?null:{kind:`script-error`,message:t.message}}function ne(e,t){if(e>0)return{kind:`settled`,outcome:`rendered`,contentHeightPx:e,errors:t};let n=v(t);return n===null?{kind:`settled`,outcome:`blank`,contentHeightPx:e,errors:t}:_(n,t)}function y(e,t){if(e.kind===`settled`)return e;switch(t.kind){case`on-screen`:return e.kind===`loading`&&e.isOnScreen!==t.isOnScreen?{...e,isOnScreen:t.isOnScreen}:e;case`height`:{if(e.kind===`settling`)return e.contentHeightPx===t.contentHeightPx?e:{...e,contentHeightPx:t.contentHeightPx};let n=t.contentHeightPx===0?v(e.errors):null;return n===null?{kind:`settling`,contentHeightPx:t.contentHeightPx,errors:e.errors}:_(n,e.errors)}case`error`:return g(t.error)?{...e,errors:[...e.errors.slice(0,9),t.error]}:e.errors.length<10?{...e,errors:[...e.errors,t.error]}:e;case`elapsed`:return e.kind===`settling`?ne(e.contentHeightPx,e.errors):e.isOnScreen?_({kind:`start-timeout`},e.errors):e}}function b(e){switch(e.kind){case`loading`:return e.isOnScreen?m:null;case`settling`:return h;case`settled`:return null}}var x=2e3,S=.01,C=10,w={text:[`--sand-text-primary`,`--sand-text-secondary`,`--sand-text-tertiary`],surfaces:[`--sand-bg-chrome`,`--sand-bg-elevated`,`--sand-bg-secondary`],lines:[`--sand-border-secondary-translucent`,`--sand-border-tertiary-translucent`],"accent and status":[`--sand-text-accent-primary`,`--sand-text-success-primary`,`--sand-text-warn-primary`,`--sand-text-danger-primary`],series:[`--sand-dataviz-0`,`--sand-dataviz-5`,`--sand-dataviz-3`,`--sand-dataviz-4`,`--sand-dataviz-2`,`--sand-dataviz-1`,`--sand-dataviz-6`,`--sand-dataviz-7`]},T=[...Object.values(w).flat(),`--sand-shadow-popover`,`--cursor-font-family-sans`];function E(e){return T.every(t=>Object.hasOwn(e,t))}function D(e){let t=e,i=[];for(let e of n){let n=r[e];t.includes(n)&&(t=t.replaceAll(n,``),i.push(e))}return{html:t,runtimes:i}}var O=`visualization-wheel`,k=`visualization-engaged`,A=`visualization-hover`,j=`visualization-error`,M=`visualization-state`,N=`visualization-pointer-left`,P=`visualization-bounds`,F=Object.freeze({type:N});function I(e){return{height:e??680,maxHeight:680}}function L(e){return{type:P,height:e.height,maxHeight:e.maxHeight}}function R(e){return typeof e==`number`&&Number.isFinite(e)?e:void 0}function z(e){if(!i(e))return null;switch(e.type){case s:{let t=c(e);return t===null?null:{kind:`height`,contentHeightPx:t}}case O:return{kind:`wheel`,deltaMode:R(e.deltaMode)??0,deltaX:R(e.deltaX)??0,deltaY:R(e.deltaY)??0};case k:return{kind:`engaged`};case A:return{kind:`hover`};case t:return{kind:`escape`};case j:{if(e.kind!==`exception`&&e.kind!==`rejection`&&e.kind!==`console`||typeof e.message!=`string`)return null;let t=typeof e.stack==`string`&&e.stack.length>0?e.stack.slice(0,p):void 0;return{kind:`error`,error:{kind:e.kind,message:e.message.slice(0,f),...t===void 0?{}:{stack:t}}}}default:return null}}function B(e){return Math.round(e.lineHeight/e.fontSize*1e4)/1e4}function V(e){return`font-size: ${e.fontSize}px; line-height: ${B(e)}; letter-spacing: ${e.letterSpacingEm}em;`}function H({body:e,small:t,label:n,h1:r,h2:i,h3:a}){return`
html { color-scheme: light; overflow: hidden; }
html[data-theme="dark"] { color-scheme: dark; }
html, body { margin: 0; background: transparent; }
* { box-sizing: border-box; }
body {
  overflow: visible;
  padding: 20px;
  color: var(--sand-text-primary);
  font-family: var(--cursor-font-family-sans);
  ${V(e)}
}
main { display: block; width: 100%; }
:where(svg) { overflow: visible; }
:where(svg text:not([fill])) { fill: currentColor; }
a { color: var(--sand-text-accent-primary); text-decoration: none; }
:is(h1, h2, h3) { margin: 0 0 8px; font-weight: 500; text-wrap: balance; }
:is(h1, h2, h3):not(:first-child) { margin-top: 24px; }
h1 { ${V(r)} }
h2 { ${V(i)} }
h3 { ${V(a)} }
p { margin: 4px 0 8px; }
p:first-child { margin-top: 0; }
p:last-child { margin-bottom: 0; }
.vis-row { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.vis-column { display: flex; flex-direction: column; gap: 12px; }
.vis-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(max(180px, 24%), 1fr)); gap: 8px; }
.vis-card {
  padding: 12px 16px;
  border: 1px solid var(--sand-border-secondary-translucent);
  border-radius: ${l.r8}px;
  background: var(--sand-bg-elevated);
  color: var(--sand-text-primary);
}
.vis-text-muted { color: var(--sand-text-secondary); }
:is(small, .vis-text-small) { ${V(t)} }
:where(svg .domain, svg .tick line) { stroke: var(--sand-border-secondary-translucent); }
:where(svg .tick text) {
  fill: var(--sand-text-secondary);
  font-family: var(--cursor-font-family-sans);
  ${V(n)}
  font-variant-numeric: tabular-nums;
}
:is(.vis-grid-x, .vis-grid-y) line, line:is(.vis-grid-x, .vis-grid-y) { stroke: var(--sand-border-tertiary-translucent); stroke-width: 1px; }
:is(.vis-grid-x, .vis-grid-y) .domain { display: none; }
.vis-label, .vis-label-muted { color: var(--sand-text-primary); ${V(n)} }
.vis-label-muted { color: var(--sand-text-secondary); }
.vis-value-label {
  color: var(--sand-text-primary);
  ${V(n)}
  font-variant-numeric: tabular-nums;
  -webkit-text-stroke: 4px var(--sand-bg-chrome);
  paint-order: stroke fill;
}
svg .vis-value-label {
  -webkit-text-stroke-width: 0;
  stroke: var(--sand-bg-chrome);
  stroke-width: 4px;
  stroke-linejoin: round;
}
.vis-tooltip {
  position: absolute;
  z-index: 50;
  width: max-content;
  max-width: 260px;
  padding: 8px 12px;
  border: 1px solid var(--sand-border-secondary-translucent);
  border-radius: ${l.r8}px;
  background: var(--sand-bg-elevated);
  color: var(--sand-text-primary);
  box-shadow: var(--sand-shadow-popover);
  ${V(n)}
  overflow-wrap: break-word;
  pointer-events: none;
  user-select: none;
}
.vis-tooltip-label { color: var(--sand-text-secondary); }
.vis-tooltip-value { color: var(--sand-text-primary); font-weight: 500; font-variant-numeric: tabular-nums; }
`.trim()}function U(){return`(function () {
  const host = window.parent;
  const sendToHost = host.postMessage.bind(host);
  const postToHost = (message) => sendToHost(message, "*");
  const read = (value, key) => {
    try {
      return value !== null && (typeof value === "object" || typeof value === "function")
        ? value[key]
        : undefined;
    } catch {
      return undefined;
    }
  };
  const text = (value) => {
    if (value === undefined || value === null) return undefined;
    try {
      return String(value);
    } catch {
      return undefined;
    }
  };
  const describe = (value) => {
    const message = text(read(value, "message"));
    if (message === undefined) return text(value) || "";
    const name = text(read(value, "name"));
    return name ? name + ": " + message : message;
  };
  const postError = (kind, message, stack) => {
    const stackText = text(stack);
    postToHost({
      type: "${j}",
      kind: kind,
      message: (message || "").slice(0, ${f}),
      stack: stackText === undefined ? undefined : stackText.slice(0, ${p}),
    });
  };
  window.addEventListener("error", (event) => {
    const error = event.error;
    const message = text(event.message) || text(read(error, "message"));
    if (error == null && message && message.startsWith("ResizeObserver loop")) return;
    postError("exception", message, read(error, "stack"));
  });
  window.addEventListener("unhandledrejection", (event) => {
    postError("rejection", describe(event.reason), read(event.reason, "stack"));
  });

  const logError = console.error;
  const now = Date.now;
  let consoleWindowStartMs = -Infinity;
  let consoleWindowCount = 0;
  console.error = function () {
    try {
      const nowMs = now();
      if (nowMs - consoleWindowStartMs >= 1000) {
        consoleWindowStartMs = nowMs;
        consoleWindowCount = 0;
      }
      if (consoleWindowCount < ${C}) {
        consoleWindowCount += 1;
        const parts = [];
        let stack;
        for (let index = 0; index < arguments.length; index += 1) {
          parts.push(describe(arguments[index]));
          const argumentStack = read(arguments[index], "stack");
          if (stack === undefined && typeof argumentStack === "string") stack = argumentStack;
        }
        postError("console", parts.join(" "), stack);
      }
    } catch {}
    return Reflect.apply(logError, this, arguments);
  };

  ${W(40)}

  const canScrollY = (node, deltaY) => {
    if (deltaY < 0) return node.scrollTop > 0;
    if (deltaY > 0) return node.scrollTop + node.clientHeight < node.scrollHeight - 1;
    return false;
  };
  const scrollsWith = (node, horizontal, deltaY) => {
    const style = window.getComputedStyle(node);
    const overflow = horizontal ? style.overflowX : style.overflowY;
    if (overflow === "hidden" || overflow === "visible") return false;
    return horizontal ? node.scrollWidth - node.clientWidth > 1 : canScrollY(node, deltaY);
  };
  const frameConsumes = (event) => {
    const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
    for (let node = event.target; node; node = node.parentNode) {
      if (!(node instanceof Element)) continue;
      if (node === document.documentElement || node === document.body) continue;
      if (scrollsWith(node, horizontal, event.deltaY)) return true;
    }
    return false;
  };
  let wheelRoute = "forwarding";
  let isHovered = false;
  window.addEventListener("pointerdown", () => {
    if (wheelRoute === "engaged") return;
    wheelRoute = "engaged";
    postToHost({ type: "${k}" });
  }, true);
  window.addEventListener("pointermove", () => {
    if (isHovered) return;
    isHovered = true;
    postToHost({ type: "${A}" });
  }, true);
  window.addEventListener("message", (event) => {
    if (event.source !== host || read(event.data, "type") !== "${N}") return;
    wheelRoute = "forwarding";
    isHovered = false;
  });
  window.addEventListener("blur", () => {
    wheelRoute = "forwarding";
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") wheelRoute = "forwarding";
  }, true);
  window.addEventListener("wheel", (event) => {
    if (wheelRoute === "engaged" || frameConsumes(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.ctrlKey) return;
    postToHost({ type: "${O}", deltaMode: event.deltaMode, deltaX: event.deltaX, deltaY: event.deltaY });
  }, { capture: true, passive: false });

  document.addEventListener("click", (event) => {
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (anchor) event.preventDefault();
  }, true);
})();`}function W(e,t){return`(function () {
  const host = window.parent;
  const sendToHost = host.postMessage.bind(host);
  let lastHeight = -1;
  let heightRaf = 0;
  const padding = ${e};
  const wholePx = (px) => Math.max(0, Math.ceil(px - ${S}));
  const measureContentHeight = () => {
    const body = document.body;
    const main = document.querySelector("main");
    if (!body && !main) {
      const docEl = document.documentElement;
      return wholePx(Math.max(docEl.scrollHeight, docEl.offsetHeight) - padding);
    }
    return wholePx(Math.max(
      ((body && body.scrollHeight) || 0) - padding,
      ((body && body.getBoundingClientRect().height) || 0) - padding,
      (main && main.scrollHeight) || 0,
      (main && main.getBoundingClientRect().height) || 0
    ));
  };
  const postHeight = () => {
    heightRaf = 0;
    ${t===void 0?``:`if (document.documentElement.hasAttribute(${JSON.stringify(t)})) return;`}
    const height = measureContentHeight();
    if (height === lastHeight) return;
    lastHeight = height;
    sendToHost({ type: "${s}", height: height }, "*");
  };
  const scheduleHeight = () => {
    if (heightRaf) return;
    heightRaf = requestAnimationFrame(postHeight);
  };
  window.addEventListener("load", scheduleHeight);
  window.addEventListener("resize", scheduleHeight, { passive: true });
  const resizeObserver = new ResizeObserver(scheduleHeight);
  const observedNodes = new WeakSet();
  const observeContent = () => {
    for (const node of [document.documentElement, document.body, document.querySelector("main")]) {
      if (node && !observedNodes.has(node)) {
        observedNodes.add(node);
        resizeObserver.observe(node);
      }
    }
  };
  observeContent();
  new MutationObserver(() => {
    observeContent();
    scheduleHeight();
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
  scheduleHeight();
})();`}function G(e){return e.replaceAll(`&`,`&amp;`).replaceAll(`<`,`&lt;`).replaceAll(`>`,`&gt;`)}function K(e,t){let n=t===`script`?/<\/script/gi:/<\/style/gi;return e.replace(n,`<\\/${t}`)}function q(e){return`<style>${K(e,`style`)}</style>`}function J(e){return`<script>${K(e,`script`)}<\/script>`}function Y(e){return e.replace(/(?<=[\s/"'])shadowrootmode(?=[\s/>=]|$)/gi,`data-shadowrootmode-blocked`)}function X(e){return`:root {\n${Object.entries(e).map(([e,t])=>`  ${e}: ${t};`).join(`
`)}\n}`}function Z({point:e,canvas:t,root:n,label:r}){if(e.z<-1||e.z>1)return null;let i=t.left+(e.x+1)/2*t.width,a=t.top+(1-e.y)/2*t.height;return{left:Math.max(8,Math.min(i-r.width/2,n.width-8-r.width)),top:Math.max(8,Math.min(a-r.height/2,n.height-8-r.height))}}var re=200;function ie(e){return`(function () {
  const place = ${Z.toString()};
  const tones = Object.assign(Object.create(null), {
    default: "var(--sand-text-primary)",
    muted: "var(--sand-text-secondary)",
    accent: "var(--sand-text-accent-primary)",
  });
  const labelCss = "position: absolute; left: 0; top: 0; white-space: nowrap; pointer-events: none;"
    + " font: 500 ${e.fontSize}px/${B(e)} var(--cursor-font-family-sans);"
    + " -webkit-text-stroke: 4px var(--sand-bg-chrome); paint-order: stroke fill;";
  return {
    labels: (root, camera) => {
      if (getComputedStyle(root).position === "static") root.style.position = "relative";
      const layer = document.createElement("div");
      layer.style.cssText = "position: absolute; inset: 0; overflow: hidden; pointer-events: none;";
      root.append(layer);
      const entries = new Map();
      const projected = new THREE.Vector3();
      const drop = (key) => {
        entries.get(key)?.element.remove();
        entries.delete(key);
      };
      return {
        add: (text, position, options) => {
          const key = String(text);
          let entry = entries.get(key);
          if (entry === undefined) {
            const element = document.createElement("div");
            element.textContent = key;
            element.style.cssText = labelCss;
            layer.append(element);
            entry = { element: element, position: position };
            entries.set(key, entry);
            if (entries.size > ${re}) drop(entries.keys().next().value);
          }
          entry.position = position;
          entry.element.style.color = tones[options?.tone] ?? tones.default;
          const added = entry;
          return {
            remove: () => {
              if (entries.get(key) === added) drop(key);
            },
          };
        },
        update: () => {
          const rootBox = root.getBoundingClientRect();
          const canvasElement = root.querySelector("canvas");
          const canvasBox = canvasElement === null ? rootBox : canvasElement.getBoundingClientRect();
          const canvas = {
            left: canvasBox.left - rootBox.left - root.clientLeft,
            top: canvasBox.top - rootBox.top - root.clientTop,
            width: canvasBox.width,
            height: canvasBox.height,
          };
          const size = { width: root.clientWidth, height: root.clientHeight };
          const placed = [...entries.values()].map((entry) => {
            projected.set(entry.position.x, entry.position.y, entry.position.z).project(camera);
            const label = { width: entry.element.offsetWidth, height: entry.element.offsetHeight };
            return { element: entry.element, at: place({ point: projected, canvas: canvas, root: size, label: label }) };
          });
          for (const { element, at } of placed) {
            element.style.visibility = at === null ? "hidden" : "visible";
            if (at !== null) element.style.transform = "translate(" + at.left + "px, " + at.top + "px)";
          }
        },
      };
    },
  };
})()`}var ae=/^#[0-9a-f]{6}([0-9a-f]{2})?$/i;function Q({color:e,backdrop:t}){let n=ae.exec(e);if(n===null)return;let r=n[1];if(r===void 0)return e;let i=(e,t)=>Number.parseInt(e.slice(t,t+2),16),a=Number.parseInt(r,16)/255;return`#${[1,3,5].map(n=>Math.round(i(e,n)*a+i(t,n)*(1-a))).map(e=>e.toString(16).padStart(2,`0`)).join(``)}`}function $(e){return JSON.stringify(e).replaceAll(`<`,`\\u003c`)}function oe(e){return`(function () {
  const host = window.parent;
  const root = document.documentElement;
  let current = ${$(e)};
  const width = () => Math.max(0, root.clientWidth - 40);
  const publish = () => {
    root.style.setProperty("--sand-viz-width", width() + "px");
    root.style.setProperty("--sand-viz-height", current.height + "px");
    root.style.setProperty("--sand-viz-max-height", current.maxHeight + "px");
  };
  const size = (value) => typeof value === "number" && value >= 0 && value <= ${o} ? value : undefined;
  publish();
  window.addEventListener("resize", publish, { passive: true });
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (event.source !== host || data === null || typeof data !== "object" || data.type !== "${P}") return;
    const height = size(data.height);
    const maxHeight = size(data.maxHeight);
    if (height === undefined || maxHeight === undefined) return;
    if (height === current.height && maxHeight === current.maxHeight) return;
    current = { height: height, maxHeight: maxHeight };
    window.dispatchEvent(new Event("resize"));
  }, true);
  return Object.freeze({
    get height() {
      return current.height;
    },
    get maxHeight() {
      return current.maxHeight;
    },
    get width() {
      return width();
    },
  });
})()`}function se(){return`(function () {
  const host = window.parent;
  let pending;
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    host.postMessage({ type: "${M}", state: pending }, "*");
  };
  return (value) => {
    let json;
    try {
      json = JSON.stringify(value);
    } catch (error) {
      console.error("SandViz.setState takes a JSON-serializable value.", error);
      return;
    }
    if (typeof json !== "string") {
      console.error("SandViz.setState takes a JSON-serializable value.");
      return;
    }
    if (json.length > ${x}) {
      console.error("SandViz.setState refused " + json.length + " characters of JSON. The limit is ${x}.");
      return;
    }
    pending = json;
    if (scheduled) return;
    scheduled = true;
    setTimeout(flush, 250);
  };
})()`}function ce(e,t,n,r){let i=Object.fromEntries(Object.entries(e).flatMap(([t,n])=>{let r=Q({color:n,backdrop:e[`--sand-bg-chrome`]});return r===void 0?[]:[[t,r]]})),a=w.series.map(t=>e[t]),o=[`tokens: Object.freeze(${$(e)})`,`series: series`,`color: (index) => series[index % series.length]`,`solid: Object.freeze(${$(i)})`,`bounds: ${oe(r)}`,`setState: ${se()}`,...n.includes(`three`)?[`...${ie(t.label)}`]:[]];return`(function () {
const series = Object.freeze(${$(a)});
window.SandViz = Object.freeze({\n  ${o.join(`,
  `)},\n});
})();`}function le(e,t){let n=t[e];return a(n!==void 0,`visualization runtime ${e} was not loaded`),J(n)}function ue(t){let n=[`<meta http-equiv="Content-Security-Policy" content="${d}">`,`<meta charset="utf-8">`,`<title>${G(t.title)}</title>`,q(X(t.themeVariables)),q(H(t.typography)),J(e(u.card)),J(U()),...t.fragment.runtimes.map(e=>le(e,t.runtimeSources)),J(ce(t.themeVariables,t.typography,t.fragment.runtimes,I(t.contentHeightPx)))];return`<!DOCTYPE html>
<html lang="en" data-theme="${t.theme}">
<head>
${n.join(`
`)}
</head>
<body>
<main>${Y(t.fragment.html)}</main>
</body>
</html>`}export{w as VISUALIZATION_DOCUMENTED_TOKENS,F as VISUALIZATION_POINTER_LEFT_MESSAGE,ue as buildVisualizationDocument,E as isVisualizationThemeVariables,y as n,Q as opaqueOver,D as parseVisualizationFragment,z as parseVisualizationFrameMessage,Z as placeVisualizationLabel,b as r,te as t,L as visualizationBoundsMessage,W as visualizationHeightReporterScript,I as visualizationInlineBounds};
//# debugId=741a8a5b-d23e-48b6-b267-2baed54a367