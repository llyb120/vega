import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compileStyle } from "vue/compiler-sfc";
import { avatarBubble, BOT_AVATAR_COLORS } from "../shared/employee-avatars";

test("quoted previews fit short and long bubbles on desktop and mobile, with readable avatar colors", { skip: process.env.VEGA_TEST_CHROME !== "1", timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "vega-chat-quote-"));
  try {
    const [component, global] = await Promise.all([readFile("web/src/ChatMessage.vue", "utf8"), readFile("web/src/style.css", "utf8")]);
    const source = component.match(/<style scoped>([\s\S]*?)<\/style>/)![1];
    const style = compileStyle({ source, filename: "ChatMessage.vue", id: "data-v-quote", scoped: true });
    assert.deepEqual(style.errors, []);
    const colors = BOT_AVATAR_COLORS.map(({ id }) => avatarBubble(`bot:round:${id}`).fill);
    const file = join(dir, "quote.html");
    await writeFile(file, `<!doctype html><meta charset="utf-8"><style>${global}\n${style.code}</style>
      <div id="fixture"></div><pre id="result"></pre><script>
        const fixture = document.querySelector('#fixture'), results = [];
        const colors = ${JSON.stringify(colors)};
        const quoteText = '需要核对发布环境与灰度配置，确认后再继续。'.repeat(20) + 'https://example.test/' + 'long-url-'.repeat(40);
        const answer = '后端合并到 dev 分支里，我写错了';
        const longAnswer = '请根据这次发布清单核对灰度范围与回滚方案，确认每个步骤都已经完成。'.repeat(8);
        const rgb = (base, overlay) => {
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
          const ctx = canvas.getContext('2d'); ctx.fillStyle = base; ctx.fillRect(0, 0, 1, 1);
          ctx.fillStyle = overlay; ctx.fillRect(0, 0, 1, 1);
          return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
        };
        const luminance = rgb => rgb.map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((n, v, i) => n + v * [.2126, .7152, .0722][i], 0);
        for (const width of [140, 320, 390, 800]) for (const kind of ['tiny', 'short', 'long', 'assistant', 'tinyquote']) {
          fixture.style.width = width + 'px';
          const mine = kind !== 'assistant';
          fixture.innerHTML = '<article data-v-quote class="chat-message ' + (mine ? 'user' : 'assistant') + '">' +
            (mine ? '' : '<span data-v-quote class="chat-avatar"></span>') +
            '<div data-v-quote class="chat-content"><div data-v-quote class="chat-bubble' + (mine ? ' tinted' : '') + '">' +
            '<button data-v-quote type="button" class="chat-quote"><strong data-v-quote>情报开发</strong><span data-v-quote></span></button>' +
            '<div data-v-quote class="message-text"></div></div></div></article>';
          const bubble = fixture.querySelector('.chat-bubble'), quote = fixture.querySelector('.chat-quote'), span = quote.querySelector('span');
          span.textContent = kind === 'tinyquote' ? '已完成' : quoteText;
          fixture.querySelector('.message-text').textContent = kind === 'tiny' || kind === 'tinyquote' ? '好' : kind === 'long' ? longAnswer : answer;
          if (mine) { bubble.style.background = colors[0]; bubble.style.color = '#fff'; }
          const box = bubble.getBoundingClientRect(), preview = quote.getBoundingClientRect(), text = span.getBoundingClientRect(), row = fixture.getBoundingClientRect();
          results.push({ width, kind, bubble: box.width, preview: preview.width, textHeight: text.height,
            contained: box.left >= row.left - 1 && box.right <= row.right + 1 && preview.left >= box.left && preview.right <= box.right && text.left >= preview.left && text.right <= preview.right });
        }
        for (const color of colors) {
          fixture.innerHTML = '<article data-v-quote class="chat-message user"><div data-v-quote class="chat-content"><div data-v-quote class="chat-bubble tinted"><button data-v-quote class="chat-quote"><strong data-v-quote>引用</strong><span data-v-quote>引用内容</span></button><div class="message-text">回复</div></div></div></article>';
          const bubble = fixture.querySelector('.chat-bubble'), quote = fixture.querySelector('.chat-quote');
          bubble.style.background = color; bubble.style.color = '#fff';
          const bg = getComputedStyle(bubble).backgroundColor, style = getComputedStyle(quote);
          const quoteBg = rgb(bg, style.backgroundColor), ink = rgb('rgb(' + quoteBg.join(',') + ')', style.color);
          const a = luminance(ink), b = luminance(quoteBg);
          results.push({ color, contrast: (Math.max(a,b) + .05) / (Math.min(a,b) + .05) });
        }
        document.querySelector('#result').textContent = JSON.stringify(results);
      </script>`);
    const output = execFileSync(process.env.VEGA_CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", "--no-first-run", "--no-default-browser-check", "--no-sandbox", "--disable-gpu", "--user-data-dir=" + join(dir, "profile"), "--dump-dom", pathToFileURL(file).href], { encoding: "utf8", timeout: 20000, windowsHide: true });
    const results = JSON.parse(output.match(/<pre id="result">([\s\S]*?)<\/pre>/)![1]);
    for (const row of results.filter((item: any) => item.width)) {
      assert(row.contained, JSON.stringify(row));
      assert(row.textHeight <= 37, "preview must be limited to two lines: " + JSON.stringify(row));
      assert(Math.abs(row.bubble - row.preview - 26) < 1, "preview follows the bubble's inner width: " + JSON.stringify(row));
      if (["short", "tiny", "tinyquote"].includes(row.kind)) assert(row.bubble <= 360, "a long quotation must not stretch a short reply: " + JSON.stringify(row));
      if (row.kind === "tinyquote") assert(row.textHeight <= 19, "a short quotation should take only one line: " + JSON.stringify(row));
      if (row.kind === "tiny" && row.width >= 320) assert(row.preview >= 180, "a short reply must leave the quote readable: " + JSON.stringify(row));
    }
    for (const row of results.filter((item: any) => item.color)) assert(row.contrast >= 4.5, "quoted text needs readable contrast: " + JSON.stringify(row));
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
