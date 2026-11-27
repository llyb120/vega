//go:build windows || (darwin && cgo)

package main

const (
	// 卡片 344 CSS px + 两侧各 8 的透明边（放阴影），与 Nova 的 .tb-shell 同一套做法。
	bubbleCSSWidth = 360
	bubbleCSSEdge  = 8
)

// bubbleCard 是页面要显示的这一张卡（字段名与页面脚本一致）。
type bubbleCard struct {
	Kind  string `json:"kind"` // running / needs_review / confirm
	Title string `json:"title"`
	Body  string `json:"body"`
	Light bool   `json:"light"`
}

// butterflyBubbleHTML 是提示卡页面：结构与配色照 Nova 的 TaskbarBubble（.tb-card）。
const butterflyBubbleHTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; background: transparent; overflow: hidden; }
  * { box-sizing: border-box; }
  body {
    font: 13px/1.55 "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    color: #f5f5f7; --accent: #0a84ff; --body: #c7c7cc;
  }
  html.light body { color: #1a1a1a; --accent: #005fb8; --body: #424242; }
  body.waiting { --accent: #ff9f0a; }
  html.light body.waiting { --accent: #9d5d00; }
  #card {
    margin: 8px; padding: 14px 16px 12px; border-radius: 16px; cursor: default; user-select: none;
    background:
      radial-gradient(90% 40% at 100% 0%, color-mix(in srgb, var(--accent) 10%, transparent), transparent 70%),
      linear-gradient(180deg, #202128 0%, #16171b 100%);
    border: 1px solid rgb(255 255 255 / .09);
    box-shadow: 0 16px 40px rgba(0, 0, 0, .42), 0 2px 8px rgba(0, 0, 0, .28), inset 0 1px 0 rgba(255, 255, 255, .06);
  }
  html.light #card {
    background:
      radial-gradient(90% 40% at 100% 0%, color-mix(in srgb, var(--accent) 10%, transparent), transparent 70%),
      linear-gradient(180deg, #f8f9fc 0%, #f1f3f8 100%);
    border-color: rgb(0 0 0 / .09);
    box-shadow: 0 16px 40px rgba(30, 40, 80, .16), 0 2px 8px rgba(30, 40, 80, .08), inset 0 1px 0 rgba(255, 255, 255, .6);
  }
  #head { display: flex; align-items: center; gap: 8px; }
  #fly { flex: none; width: 16px; height: 13px; overflow: visible; fill: var(--accent); }
  #fly .body { fill: currentColor; }
  #wings { transform-box: fill-box; transform-origin: center; animation: flap 0.6s ease-in-out infinite; }
  body.waiting #wings { animation-duration: 1.4s; }
  @keyframes flap { 50% { transform: scaleX(0.2); } }
  #state { font-size: 13.5px; font-weight: 600; letter-spacing: .01em; }
  #body { margin-top: 10px; color: var(--body); overflow-wrap: anywhere; }
  #actions { display: none; gap: 8px; margin-top: 12px; }
  #actions button {
    flex: 1; padding: 7px 10px; border-radius: 9px; font: inherit; font-weight: 600; cursor: pointer;
    border: 1px solid rgb(255 255 255 / .14); background: rgb(255 255 255 / .08); color: inherit;
  }
  #actions button:disabled { opacity: .6; cursor: default; }
  #actions button[data-a="allow"] { background: var(--accent); border-color: transparent; color: #fff; }
  html.light #actions button { border-color: rgb(0 0 0 / .12); background: rgb(0 0 0 / .05); }
  html.light #actions button[data-a="allow"] { background: var(--accent); color: #fff; }
</style></head>
<body class="running"><div id="card">
  <div id="head">
    <svg id="fly" viewBox="-8 -7 16 13" aria-hidden="true"><g id="wings">
      <path d="M0.5-0.5L1.8-4.4L4.4-6L7-5.2L7-2.6L0.5 0.6ZM0.5 0.6L4.6 1L5 3.4L2.8 5.2L0.5 2.8Z"/>
      <path d="M0.5-0.5L1.8-4.4L4.4-6L7-5.2L7-2.6L0.5 0.6ZM0.5 0.6L4.6 1L5 3.4L2.8 5.2L0.5 2.8Z" transform="scale(-1 1)"/>
    </g><rect class="body" x="-0.9" y="-4.6" width="1.8" height="9.2" rx="0.9"/></svg>
    <span id="state"></span>
  </div>
  <div id="body"></div>
  <div id="actions"><button data-a="allow">现在接管</button><button data-a="reject">我在用，过会再问</button></div>
</div>
<script>
  const post = m => { try { window.chrome.webview.postMessage(m); } catch (e) {} };
  const card = document.getElementById('card');
  const actions = document.getElementById('actions');
  let kind = 'running';
  window.butterflyBubble = d => {
    kind = d.kind || 'running';
    document.documentElement.classList.toggle('light', !!d.light);
    document.body.className = kind === 'running' ? 'running' : 'waiting';
    document.getElementById('state').textContent = d.title || '';
    document.getElementById('body').textContent = d.body || '';
    document.getElementById('body').style.display = d.body ? '' : 'none';
    actions.style.display = kind === 'confirm' ? 'flex' : 'none';
    for (const button of actions.querySelectorAll('button')) button.disabled = false;
    report();
  };
  let last = 0;
  const report = () => requestAnimationFrame(() => {
    const h = Math.ceil(card.getBoundingClientRect().height) + 16;
    if (h > 0 && h !== last) { last = h; post('h:' + h); }
  });
  // 确认卡上的两个选择回给 Go；卡片本身不当作“点开面板”。
  actions.addEventListener('click', ev => {
    const button = ev.target.closest('button');
    if (!button || button.disabled) return;
    for (const other of actions.querySelectorAll('button')) other.disabled = true;
    post('answer:' + button.dataset.a);
  });
  card.addEventListener('click', () => { if (kind !== 'confirm') post('open'); });
  window.addEventListener('resize', report);
  post('ready');
</script>
</body></html>`
