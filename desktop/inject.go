package main

// shimJS is injected after every page load so the Vega web app can detect
// desktop mode and talk to the Wails window (min/max/close/drag), even after
// the webview has navigated to the configured Vega server.
const shimJS = `(function(){
  document.documentElement.classList.add("is-desktop");
  if (document.body) document.body.classList.add("is-desktop");
  window.__VEGA_DESKTOP__ = true;
  try { window.dispatchEvent(new Event("vega-desktop-ready")); } catch (e) {}
  var post = null;
  if (window.chrome && window.chrome.webview && window.chrome.webview.postMessage) {
    post = function(m){ window.chrome.webview.postMessage(m); };
  } else if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.external) {
    post = function(m){ window.webkit.messageHandlers.external.postMessage(m); };
  }
  if (post && !window.WailsInvoke) window.WailsInvoke = post;
  if (!window.runtime) {
    window.runtime = {
      WindowMinimise: function(){ window.WailsInvoke && window.WailsInvoke("Wm"); },
      WindowToggleMaximise: function(){ window.WailsInvoke && window.WailsInvoke("Wt"); },
      Quit: function(){ window.WailsInvoke && window.WailsInvoke("Q"); },
      EventsEmit: function(name){
        var data = [].slice.call(arguments, 1);
        window.WailsInvoke && window.WailsInvoke("EE" + JSON.stringify({name: name, data: data}));
      }
    };
  }
  if (window.wails && window.wails.flags) return;
  if (window.__VEGA_DESKTOP_DRAG__) return;
  window.__VEGA_DESKTOP_DRAG__ = true;
  var shouldDrag = false;
  window.addEventListener("mousedown", function(e){
    if (e.buttons !== 1 || e.detail !== 1) return;
    var el = e.target;
    if (el.closest && el.closest("button, a, input, textarea, select, summary, label, [data-no-drag]")) return;
    while (el && el.nodeType === 1) {
      var val = (window.getComputedStyle(el).getPropertyValue("--wails-draggable") || "").trim();
      if (val === "no-drag") return;
      if (val === "drag") { shouldDrag = true; return; }
      el = el.parentElement;
    }
  }, true);
  window.addEventListener("mouseup", function(){ shouldDrag = false; }, true);
  window.addEventListener("mousemove", function(e){
    if (shouldDrag && e.buttons) {
      shouldDrag = false;
      window.WailsInvoke && window.WailsInvoke("drag");
    }
  }, true);
})();`
