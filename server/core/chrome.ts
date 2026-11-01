import { normalizeAction } from "./browser-actions";
import sharp from "sharp";
import type { Store } from "./store";
import { ChromeBridge } from "./chrome-bridge";
import { Experiences } from "./experiences";
import {
  assert,
  clip,
  id,
  sleep,
  workspaceFile,
  Mutex,
  type Obj,
} from "./util";
type Frame = { id: string; parent?: string; session?: string; context: number };
type Observation = {
  id: string;
  tabTag: string;
  frames: Frame[];
  pages: Obj[];
  coverageGaps: string[];
  images: Obj[];
  captured: number;
  fullPage: boolean;
  screenshot: boolean;
};
export class Chrome {
  gate = new Mutex();
  tabGates = new Map<string, Mutex>();
  tabGate(tag: string) {
    let gate = this.tabGates.get(tag);
    if (!gate) this.tabGates.set(tag, (gate = new Mutex()));
    return gate;
  }
  observations = new Map<string, Observation>();
  cancelled = new Map<string, AbortController>();
  experiences: Experiences;
  constructor(
    public store: Store,
    public bridge: ChromeBridge,
    public pageScript: string,
    experienceKind = "experience",
  ) {
    this.experiences = new Experiences(store, experienceKind);
  }
  cdp(
    tag: string,
    method: string,
    params: Obj = {},
    sessionId?: string,
    signal?: AbortSignal,
  ) {
    return this.bridge.request(
      "cdp",
      { tabTag: tag, method, params, sessionId },
      signal,
    );
  }
  async evaluate(
    tag: string,
    frame: Frame,
    expression: string,
    signal?: AbortSignal,
  ) {
    const r = await this.cdp(
      tag,
      "Runtime.evaluate",
      {
        expression,
        contextId: frame.context,
        returnByValue: true,
        awaitPromise: true,
      },
      frame.session,
      signal,
    );
    assert(
      !r.exceptionDetails,
      r.exceptionDetails?.exception?.description || "Page evaluation failed",
    );
    return r.result?.value;
  }
  async observe(
    tag: string,
    scope = "all",
    signal?: AbortSignal,
  ): Promise<Observation> {
    const frames: Frame[] = [],
      gaps: string[] = [];
    const collect = (tree: Obj, session?: string) => {
      if (tree.frame?.id)
        frames.push({
          id: tree.frame.id,
          parent: tree.frame.parentId,
          session,
          context: 0,
        });
      for (const c of tree.childFrames || []) collect(c, session);
    };
    const tree = await this.cdp(
      tag,
      "Page.getFrameTree",
      {},
      undefined,
      signal,
    );
    collect(tree.frameTree);
    const targets = await this.cdp(
      tag,
      "Target.getTargets",
      {},
      undefined,
      signal,
    );
    for (const target of (targets.targetInfos || [])
      .filter((v: Obj) => v.type === "iframe")
      .slice(0, 12)) {
      try {
        const attached = await this.cdp(
          tag,
          "Target.attachToTarget",
          { targetId: target.targetId, flatten: true },
          undefined,
          signal,
        );
        const child = await this.cdp(
          tag,
          "Page.getFrameTree",
          {},
          attached.sessionId,
          signal,
        );
        if (
          frames.some(
            (f) =>
              f.id === child.frameTree.frame.parentId ||
              f.id === child.frameTree.frame.id,
          )
        ) {
          const old = frames.findIndex(
            (f) => f.id === child.frameTree.frame.id,
          );
          if (old >= 0) frames.splice(old, 1);
          collect(child.frameTree, attached.sessionId);
        }
      } catch (e: any) {
        gaps.push(e.message);
      }
    }
    if (frames.length > 12)
      gaps.push(
        "Only the first 12 frames were observed; coverage is incomplete",
      );
    const pages: Obj[] = [],
      ready: Frame[] = [];
    for (const frame of frames.slice(0, 12)) {
      try {
        const world = await this.cdp(
          tag,
          "Page.createIsolatedWorld",
          { frameId: frame.id, worldName: "nova-browser-control" },
          frame.session,
          signal,
        );
        frame.context = world.executionContextId;
        const page = await this.evaluate(
          tag,
          frame,
          `${this.pageScript};__novaWebview.observe(${JSON.stringify(id())},20000,${JSON.stringify(scope)})`,
          signal,
        );
        page.frame = ready.length;
        pages.push(page);
        ready.push(frame);
      } catch (e: any) {
        if (!frame.parent && !frame.session) throw e;
        gaps.push(e.message);
      }
    }
    assert(pages.length, "Page not ready");
    return {
      id: id(),
      tabTag: tag,
      frames: ready,
      pages,
      coverageGaps: gaps,
      images: [],
      captured: Date.now(),
      fullPage: false,
      screenshot: false,
    };
  }
  async capture(o: Observation, a: Obj, prior?: Observation) {
    const tag = o.tabTag,
      page = o.pages[0],
      vp = page.viewport;
    const dpr = vp.devicePixelRatio || 1;
    let region = a.region;
    assert(!region || !a.ref, "Use region or ref, not both");
    if (a.ref) {
      const frame = o.frames[a.frame || 0];
      assert(frame, "Unknown frame");
      region = await this.evaluate(
        tag,
        frame,
        `__novaWebview.documentRect(${JSON.stringify(a.ref)})`,
      );
      if (!a.fullPage) {
        region.x -= vp.scrollX;
        region.y -= vp.scrollY;
      }
    }
    let expanded: any;
    try {
      if (a.expandScroll) {
        let over = await this.evaluate(
            tag,
            o.frames[0],
            `__novaWebview.innerScrollOverflow(${JSON.stringify(a.ref || null)})`,
          ),
          height = vp.height;
        for (let i = 0; i < 3 && over > 1; i++) {
          const next = Math.min(16383 / dpr, height + over);
          if (next <= height) break;
          await this.cdp(tag, "Emulation.setDeviceMetricsOverride", {
            width: vp.width,
            height: Math.floor(next),
            deviceScaleFactor: 0,
            mobile: false,
          });
          await this.evaluate(
            tag,
            o.frames[0],
            "__novaWebview.settle(300,1500)",
          );
          const after = await this.evaluate(
            tag,
            o.frames[0],
            `__novaWebview.innerScrollOverflow(${JSON.stringify(a.ref || null)})`,
          );
          if (after >= over - 1) break;
          height = next;
          over = after;
        }
        expanded = { complete: over <= 1, height };
        if (a.ref)
          region = await this.evaluate(
            tag,
            o.frames[a.frame || 0],
            `__novaWebview.documentRect(${JSON.stringify(a.ref)})`,
          );
      }
      const full = a.fullPage === true || !!a.expandScroll;
      o.fullPage = full;
      o.screenshot = true;
      const documentSize = a.expandScroll
        ? (await this.cdp(tag, "Page.getLayoutMetrics")).cssContentSize ||
          page.documentSize ||
          {}
        : page.documentSize || {};
      const width =
          region?.width || (full ? documentSize.width : vp.width) || vp.width,
        totalHeight =
          region?.height ||
          (full ? documentSize.height : vp.height) ||
          vp.height;
      assert(width > 0 && totalHeight > 0, "Empty screenshot region");
      const tileHeight =
        full && !a.expandScroll
          ? Math.min(1600, Math.floor(16383 / dpr))
          : Math.min(totalHeight, Math.floor(16383 / dpr));
      const tiles = Math.ceil(totalHeight / tileHeight),
        offset = a.tileOffset || 0;
      assert(
        Number.isInteger(offset) && offset >= 0 && offset < tiles,
        "Invalid tileOffset",
      );
      const maxTiles = a.expandScroll ? 1 : Math.min(2, tiles - offset);
      for (let i = offset; i < offset + maxTiles; i++) {
        const x = region?.x || (full ? 0 : vp.scrollX || 0),
          y = (region?.y || (full ? 0 : vp.scrollY || 0)) + i * tileHeight,
          h = Math.min(tileHeight, totalHeight - i * tileHeight),
          clipRect = { x, y, width, height: h, scale: 1 };
        const shot = await this.cdp(tag, "Page.captureScreenshot", {
          format: "webp",
          quality: 100,
          fromSurface: true,
          captureBeyondViewport: full,
          clip: clipRect,
        });
        const bytes = Buffer.from(shot.data, "base64");
        let image = sharp(bytes, { limitInputPixels: 64000000 });
        const metadata = await image.metadata();
        assert(metadata.width && metadata.height, "Invalid screenshot");
        const edge = Math.min(a.maxEdge || 1600, 1568),
          scale = Math.min(
            1,
            edge / Math.max(metadata.width, metadata.height),
            Math.sqrt(1150000 / (metadata.width * metadata.height)),
          );
        if (scale < 1)
          image = image.resize(
            Math.max(1, Math.round(metadata.width * scale)),
            Math.max(1, Math.round(metadata.height * scale)),
          );
        const { data, info } = await image
          .webp({ lossless: true })
          .toBuffer({ resolveWithObject: true });
        const blob = this.store.blob("image/webp", data);
        let imageID = o.id + "-" + o.images.length,
          unchanged = false,
          blobID = blob;
        const previous = prior?.images.find(
          (v) =>
            v.x === x &&
            v.y === y &&
            v.width === width &&
            v.height === h &&
            v.pixelWidth === info.width &&
            v.pixelHeight === info.height,
        );
        if (
          previous &&
          Date.now() - (prior?.captured || 0) <= 180000 &&
          prior?.pages[0].document === page.document &&
          prior?.pages[0].stamp === page.stamp
        ) {
          const old = this.store.blobData(previous.blobId);
          if (old) {
            const [a, b] = await Promise.all([
              sharp(old.data).resize(32, 32).removeAlpha().raw().toBuffer(),
              sharp(data).resize(32, 32).removeAlpha().raw().toBuffer(),
            ]);
            if (
              a.length === b.length &&
              a.every((v, i) => Math.abs(v - b[i]) <= 16)
            ) {
              unchanged = true;
              imageID = previous.imageId;
              blobID = previous.blobId;
            }
          }
        }
        o.images.push({
          imageId: imageID,
          snapshotId: o.id,
          blobId: blobID,
          path: `sqlite:blob/${blobID}`,
          url: `/api/blobs/${blobID}`,
          x,
          y,
          width,
          height: h,
          pixelWidth: info.width,
          pixelHeight: info.height,
          frameStream: `${tag}:${full ? "document" : "viewport"}`,
          unchanged,
          readOnlyImage: !!a.expandScroll,
        });
      }
      return {
        fullPage: full,
        scrollExpanded: expanded,
        totalTiles: tiles,
        nextTile: offset + maxTiles < tiles ? offset + maxTiles : undefined,
      };
    } finally {
      if (a.expandScroll) {
        await this.cdp(tag, "Emulation.clearDeviceMetricsOverride").catch(
          () => {},
        );
        await this.evaluate(
          tag,
          o.frames[0],
          "__novaWebview.settle(200,1000)",
        ).catch(() => {});
      }
    }
  }
  summarize(o: Observation, a: Obj) {
    const limit = a.maxItems ?? 60,
      maxText = a.maxTextChars ?? 3000;
    assert(
      Number.isInteger(limit) &&
        limit >= 1 &&
        limit <= 20000 &&
        Number.isInteger(maxText) &&
        maxText >= 0 &&
        maxText <= 65536,
      "Invalid observation budgets",
    );
    let remain = limit;
    return o.pages.map((page) => {
      const query = String(a.query || "").toLowerCase(),
        matched = (page.items || []).filter(
          (v: Obj) => !query || JSON.stringify(v).toLowerCase().includes(query),
        ),
        items = matched.slice(0, remain);
      remain = Math.max(0, remain - items.length);
      return {
        ...page,
        text: clip(
          query
            ? (page.fullText || page.text || "")
                .split("\n")
                .filter((s: string) => s.toLowerCase().includes(query))
                .join("\n")
            : page.text || "",
          maxText,
        ),
        fullText: undefined,
        items,
        elements: items
          .map(
            (v: Obj) =>
              `${v.ref} ${v.role} ${JSON.stringify(v.name)}${v.region ? " @ " + v.region : ""}${v.href ? " href=" + v.href : ""}${v.inView ? "" : " offscreen"}`,
          )
          .join("\n"),
        matchingItems: matched.length,
        totalItems: (page.items || []).length,
        truncated: matched.length > items.length,
      };
    });
  }
  async feedback(
    owner: string,
    tag: string,
    a: Obj,
    mode = "inspect",
    signal?: AbortSignal,
  ) {
    const key = owner + ":" + tag,
      prior = this.observations.get(key),
      o = await this.observe(tag, a.scope || "all", signal);
    const capture =
      mode === "screenshot" ||
      a.feedback === "screenshot" ||
      (!["none", "inspect"].includes(a.feedback) && a.visual !== "none");
    const shot = capture ? await this.capture(o, a, prior) : {};
    this.observations.set(key, o);
    for (const image of o.images) {
      if (owner.startsWith("browser-view:")) this.store.grantBlobUser(image.blobId, owner.slice("browser-view:".length));
      else this.store.grantBlob(image.blobId, owner);
    }
    this.store.save("browser-observation", o.id, { ...o, frames: undefined });
    const origin = new URL(o.pages[0].url).origin;
    return {
      browser: "chrome",
      tabTag: tag,
      snapshotId: o.id,
      pages: this.summarize(o, a),
      coverageGaps: o.coverageGaps,
      documentPath: `sqlite:browser-observation/${o.id}`,
      images: o.images,
      ...shot,
      experienceHint: this.experiences.hint(owner, origin),
    };
  }
  async point(
    o: Observation,
    frameIndex: number,
    ref: string | null,
    mode: string,
  ) {
    const frame = o.frames[frameIndex];
    assert(frame, "Unknown frame");
    const chain: { parent: Frame; object: string }[] = [];
    let child = frame;
    while (child.parent) {
      assert(chain.length < 12, "Frame nesting exceeds 12");
      const parent = o.frames.find((f) => f.id === child.parent);
      assert(parent, "Parent frame inaccessible");
      const node = await this.cdp(
        o.tabTag,
        "DOM.getFrameOwner",
        { frameId: child.id },
        parent.session,
      );
      const resolved = await this.cdp(
        o.tabTag,
        "DOM.resolveNode",
        {
          backendNodeId: node.backendNodeId,
          executionContextId: parent.context,
        },
        parent.session,
      );
      const obj = resolved.object?.objectId;
      assert(obj, "Frame owner inaccessible");
      chain.push({ parent, object: obj });
      child = parent;
    }
    try {
      for (const { parent, object } of [...chain].reverse())
        await this.cdp(
          o.tabTag,
          "Runtime.callFunctionOn",
          {
            objectId: object,
            functionDeclaration:
              "async function(){const r=this.getBoundingClientRect();if(r.bottom<=0||r.top>=innerHeight||r.right<=0||r.left>=innerWidth){this.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});await new Promise(r=>setTimeout(r,50));}}",
            awaitPromise: true,
          },
          parent.session,
        );
      let p = await this.evaluate(
        o.tabTag,
        frame,
        `__novaWebview.prepare(${JSON.stringify(ref)},${JSON.stringify(mode)})`,
      );
      p.localRect = p.rect;
      for (const { parent, object } of chain) {
        const value = await this.cdp(
          o.tabTag,
          "Runtime.callFunctionOn",
          {
            objectId: object,
            returnByValue: true,
            arguments: [{ value: p }],
            functionDeclaration:
              "function(p){const r=this.getBoundingClientRect();for(let e=this;e;e=e.parentElement||e.getRootNode()?.host){const t=getComputedStyle(e).transform;if(t!=='none'){const m=new DOMMatrixReadOnly(t);if(!m.is2D||m.a<=0||m.d<=0||Math.abs(m.b)>.00001||Math.abs(m.c)>.00001)throw Error('Unsafe iframe transform');}}const sx=r.width/this.offsetWidth,sy=r.height/this.offsetHeight,x=r.x+(this.clientLeft+p.x)*sx,y=r.y+(this.clientTop+p.y)*sy;let hit=this.ownerDocument.elementFromPoint(x,y);while(hit?.shadowRoot){const n=hit.shadowRoot.elementFromPoint(x,y);if(!n||n===hit)break;hit=n}if(hit!==this)throw Error('Frame occluded');return {x,y,rect:{x:r.x+(this.clientLeft+p.rect.x)*sx,y:r.y+(this.clientTop+p.rect.y)*sy,width:p.rect.width*sx,height:p.rect.height*sy}}}",
          },
          parent.session,
        );
        assert(!value.exceptionDetails, "Unsafe frame coordinate transform");
        p = { ...p, ...value.result.value };
      }
      return p;
    } finally {
      for (const { parent, object } of chain)
        await this.cdp(
          o.tabTag,
          "Runtime.releaseObject",
          { objectId: object },
          parent.session,
        ).catch(() => {});
    }
  }
  async key(tag: string, name: string) {
    const parts = name.split("+"),
      base = parts.pop()!;
    let modifiers = 0;
    for (const m of parts) {
      const bit = (
        { Alt: 1, Ctrl: 2, Control: 2, Meta: 4, Cmd: 4, Shift: 8 } as Obj
      )[m];
      assert(bit, "Unsupported key modifier");
      modifiers |= bit;
    }
    const keys: Obj = {
      Enter: 13,
      Tab: 9,
      Escape: 27,
      Backspace: 8,
      Delete: 46,
      Home: 36,
      End: 35,
      PageUp: 33,
      PageDown: 34,
      ArrowLeft: 37,
      ArrowUp: 38,
      ArrowRight: 39,
      ArrowDown: 40,
      Space: 32,
    };
    let vk = keys[base],
      key = base,
      code = base;
    if (/^F(?:[1-9]|1[0-2])$/.test(base)) vk = 111 + Number(base.slice(1));
    if (/^[a-z0-9]$/i.test(base) && modifiers & 7) {
      vk = base.toUpperCase().charCodeAt(0);
      key = modifiers & 8 ? base.toUpperCase() : base.toLowerCase();
      code = /\d/.test(base) ? "Digit" + base : "Key" + base.toUpperCase();
    }
    assert(vk, "Unsupported key; use type for printable text");
    if (base === "Space") key = " ";
    const up = {
        type: "keyUp",
        key,
        code,
        windowsVirtualKeyCode: vk,
        modifiers,
      },
      down: Obj = { ...up, type: "keyDown" };
    if (modifiers === 2 && [67, 88, 86].includes(vk))
      down.commands = [vk === 67 ? "copy" : vk === 88 ? "cut" : "paste"];
    try {
      await this.cdp(tag, "Input.dispatchKeyEvent", down);
    } finally {
      await this.cdp(tag, "Input.dispatchKeyEvent", up);
    }
  }
  async mouse(tag: string, p: Obj, button = "left", count = 1) {
    assert(
      ["left", "right", "middle"].includes(button) && [1, 2].includes(count),
      "Invalid mouse button/count",
    );
    for (let n = 1; n <= count; n++) {
      try {
        await this.cdp(tag, "Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: p.x,
          y: p.y,
          button,
          clickCount: n,
        });
      } finally {
        await this.cdp(tag, "Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: p.x,
          y: p.y,
          button,
          clickCount: n,
        });
      }
    }
  }
  async frameFocused(o: Observation, index: number) {
    let child = o.frames[index];
    assert(child, "Unknown focus frame");
    let depth = 0;
    while (child.parent) {
      assert(++depth <= 12, "Focus frame nesting exceeded");
      const parent = o.frames.find((f) => f.id === child.parent);
      assert(parent, "Focus parent inaccessible");
      const owner = await this.cdp(
          o.tabTag,
          "DOM.getFrameOwner",
          { frameId: child.id },
          parent.session,
        ),
        resolved = await this.cdp(
          o.tabTag,
          "DOM.resolveNode",
          {
            backendNodeId: owner.backendNodeId,
            executionContextId: parent.context,
          },
          parent.session,
        ),
        object = resolved.object?.objectId;
      assert(object, "Focus frame owner inaccessible");
      try {
        const result = await this.cdp(
          o.tabTag,
          "Runtime.callFunctionOn",
          {
            objectId: object,
            returnByValue: true,
            functionDeclaration:
              "function(){let e=this.ownerDocument.activeElement;while(e?.shadowRoot?.activeElement)e=e.shadowRoot.activeElement;return e===this}",
          },
          parent.session,
        );
        if (result.result?.value !== true) return false;
      } finally {
        await this.cdp(
          o.tabTag,
          "Runtime.releaseObject",
          { objectId: object },
          parent.session,
        ).catch(() => {});
      }
      child = parent;
    }
    return true;
  }
  async action(
    o: Observation,
    a: Obj,
    top: Obj,
    cwd: string,
    progress: Obj,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const tag = o.tabTag,
      kind = a.action || a.type;
    let frameIndex = a.frame ?? 0;
    if (["click", "fill", "scroll"].includes(kind) && a.ref) {
      const actual = o.pages.findIndex((p) =>
        p.items.some((v: Obj) => v.ref === a.ref),
      );
      assert(
        actual >= 0,
        "ref not found in observed frames; never fabricate refs",
      );
      frameIndex = actual;
    }
    const frame = o.frames[frameIndex];
    const changed = () => (progress.attempted = true);
    if (kind === "wait") {
      assert(
        Number.isInteger(a.ms) && a.ms >= 0 && a.ms <= 2000,
        "wait is 0–2000ms",
      );
      await sleep(a.ms, signal);
      return;
    }
    if (["click", "fill", "scroll"].includes(kind)) {
      assert(frame, "Unknown frame");
      const mode =
        kind === "scroll" ? (a.delta_x ? "scroll_x" : "scroll_y") : kind;
      // Lyra dom_preflight: resolving the DOM ref to a point cannot have sent
      // input; it stays set through hover-verify for click/fill.
      progress.domPreflight = true;
      const p = await this.point(o, frameIndex, a.ref || null, mode);
      if (kind === "scroll") {
        progress.domPreflight = false;
        assert(
          Math.abs(a.delta) <= 1200 && Math.abs(a.delta_x || 0) <= 1200,
          "Scroll exceeds 1200 pixels",
        );
        changed();
        await this.cdp(tag, "Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: p.x,
          y: p.y,
          deltaX: a.delta_x || 0,
          deltaY: a.delta,
        });
        progress.scrollFeedback = await this.evaluate(
          tag,
          frame,
          `__novaWebview.scrollFeedback(${JSON.stringify(a.ref || null)},${JSON.stringify(p.scroll)})`,
        );
        return;
      }
      changed();
      await this.cdp(tag, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: p.x,
        y: p.y,
      });
      await this.evaluate(
        tag,
        frame,
        `__novaWebview.verifyPoint(${JSON.stringify(a.ref)},${p.localX},${p.localY},${JSON.stringify(p.localRect)},${JSON.stringify(mode)})`,
      );
      if (frame.parent) {
        const after = await this.point(o, frameIndex, a.ref, mode);
        assert(
          Math.abs(after.x - p.x) < 0.5 && Math.abs(after.y - p.y) < 0.5,
          "Iframe moved after hover; no click sent",
        );
      }
      await this.mouse(tag, p, a.button || "left", a.click_count || 1);
      progress.focus = p.editable
        ? { frame: frameIndex, identity: p.identity }
        : undefined;
      if (kind === "fill") {
        assert(
          typeof a.text === "string" && a.text.length <= 16000,
          "Fill text exceeds 16000",
        );
        const requireFocus = async () => {
          const state = await this.evaluate(
            tag,
            frame,
            `__novaWebview.inputState(${JSON.stringify(a.ref)})`,
          );
          assert(
            state.matches &&
              state.editable &&
              (await this.frameFocused(o, frameIndex)),
            "Focus changed or field is read-only; input stopped",
          );
        };
        await requireFocus();
        await this.key(tag, "Control+A");
        await requireFocus();
        await this.cdp(tag, "Input.insertText", { text: a.text });
        const actual = await this.evaluate(
          tag,
          frame,
          `__novaWebview.verifyValue(${JSON.stringify(a.ref)},${JSON.stringify(a.text)})`,
        );
        assert(
          actual.matches,
          "Actual input differs from requested value; do not resubmit blindly",
        );
      }
      return;
    }
    if (kind === "upload") {
      assert(
        frame &&
          typeof a.selector === "string" &&
          a.selector.length <= 2000 &&
          Array.isArray(a.files) &&
          a.files.length > 0 &&
          a.files.length <= 16,
        "upload requires a frame, unique selector and 1–16 workspace files",
      );
      const files = await Promise.all(
        a.files.map((p: string) => workspaceFile(cwd, p)),
      );
      const r = await this.cdp(
        tag,
        "Runtime.evaluate",
        {
          expression: `(()=>{const a=document.querySelectorAll(${JSON.stringify(a.selector)});if(a.length!==1)throw Error('File input selector must be unique');const e=a[0];if(!(e instanceof HTMLInputElement)||e.type!=='file'||e.disabled||e.webkitdirectory||(!e.multiple&&${files.length}>1))throw Error('Invalid file input');return e})()`,
          contextId: frame.context,
          returnByValue: false,
        },
        frame.session,
      );
      assert(
        !r.exceptionDetails && r.result.objectId,
        "Upload target validation failed",
      );
      changed();
      try {
        await this.cdp(
          tag,
          "DOM.setFileInputFiles",
          { objectId: r.result.objectId, files },
          frame.session,
        );
      } finally {
        await this.cdp(
          tag,
          "Runtime.releaseObject",
          { objectId: r.result.objectId },
          frame.session,
        ).catch(() => {});
      }
      return;
    }
    if (kind === "type" || kind === "press") {
      if (kind === "type") {
        assert(
          typeof a.text === "string" && a.text.length <= 16000,
          "Invalid text",
        );
        let verified = false;
        for (const [i, f] of o.frames.entries()) {
          const now = await this.evaluate(tag, f, "__novaWebview.inputState()"),
            expected =
              progress.focus?.frame === i
                ? progress.focus.identity
                : o.pages[i].focus?.identity;
          if (
            now.editable &&
            now.identity === expected &&
            (await this.frameFocused(o, i))
          ) {
            verified = true;
            break;
          }
        }
        assert(
          verified,
          "No confirmed editable focus; use fill or click first",
        );
      } else if (progress.focus) {
        const f = o.frames[progress.focus.frame],
          state = await this.evaluate(tag, f, "__novaWebview.inputState()");
        assert(
          state.identity === progress.focus.identity &&
            (await this.frameFocused(o, progress.focus.frame)),
          "Keyboard focus changed; input stopped",
        );
      }
      changed();
      if (kind === "type")
        await this.cdp(tag, "Input.insertText", { text: a.text });
      else {
        await this.key(tag, a.key);
        if (/^(Ctrl|Control)\+C$/.test(a.key)) {
          try {
            const copied = await this.evaluate(
              tag,
              o.frames[progress.focus?.frame || 0],
              `navigator.clipboard.readText()`,
            );
            progress.clipboard = { text: copied };
          } catch {
            progress.clipboard = {
              unavailable: true,
              notice:
                "Clipboard permission unavailable; no values inferred from screenshot",
            };
          }
        }
      }
      return;
    }
    if (["click_at", "move", "drag", "scroll_at"].includes(kind)) {
      assert(o.screenshot, "Coordinate actions require an observed screenshot");
      const image = top.imageId
        ? o.images.find((i) => i.imageId === top.imageId)
        : o.images.length === 1
          ? o.images[0]
          : undefined;
      assert(image && !image.readOnlyImage, "Use matching actionable imageId");
      const map = (x: number, y: number) => {
        assert(
          Number.isFinite(x) &&
            Number.isFinite(y) &&
            x >= 0 &&
            y >= 0 &&
            x < image.pixelWidth &&
            y < image.pixelHeight,
          "Coordinates outside image",
        );
        return {
          x: image.x + (x * image.width) / image.pixelWidth,
          y: image.y + (y * image.height) / image.pixelHeight,
        };
      };
      const xy = map(a.x, a.y);
      const p = await this.evaluate(
        tag,
        o.frames[0],
        `__novaWebview.coordinate(${xy.x},${xy.y},${JSON.stringify(o.pages[0].stamp)},${o.fullPage})`,
      );
      changed();
      await this.cdp(tag, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: p.x,
        y: p.y,
      });
      if (p.hoverTarget) {
        await this.evaluate(
          tag,
          o.frames[0],
          `__novaWebview.verifyPoint(${JSON.stringify(p.hoverTarget.ref)},${p.x},${p.y},${JSON.stringify(p.hoverTarget.rect)})`,
        );
        const hovered = await this.evaluate(tag, o.frames[0], `__novaWebview.stamp()`);
        assert(hovered === p.stamp, "悬停期间视口已变化，停止点击");
      }
      if (kind === "click_at") {
        await this.mouse(tag, p, a.button || "left", a.click_count || 1);
        progress.focus = p.editable
          ? { frame: 0, identity: p.identity }
          : undefined;
      } else if (kind === "scroll_at") {
        assert(
          Math.abs(a.delta) <= 1200 && Math.abs(a.delta_x || 0) <= 1200,
          "Scroll exceeds limit",
        );
        await this.cdp(tag, "Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: p.x,
          y: p.y,
          deltaX: a.delta_x || 0,
          deltaY: a.delta,
        });
      } else if (kind === "drag") {
        assert(!o.fullPage, "Drag requires viewport screenshot");
        const end = map(a.to_x, a.to_y),
          duration = a.duration_ms ?? 160;
        assert(duration >= 80 && duration <= 1500, "Drag duration 80–1500ms");
        const steps = Math.max(5, Math.min(24, Math.floor(duration / 16)));
        let last = p;
        try {
          await this.cdp(tag, "Input.dispatchMouseEvent", {
            type: "mousePressed",
            x: p.x,
            y: p.y,
            button: "left",
            buttons: 1,
            clickCount: 1,
          });
          // Let drag handlers initialize and settle before releasing.
          await sleep(120, signal);
          for (let i = 1; i <= steps; i++) {
            signal.throwIfAborted();
            last = {
              x: p.x + ((end.x - p.x) * i) / steps,
              y: p.y + ((end.y - p.y) * i) / steps,
            };
            await this.cdp(tag, "Input.dispatchMouseEvent", {
              type: "mouseMoved",
              ...last,
              button: "left",
              buttons: 1,
            });
            await sleep(duration / steps, signal);
          }
          await sleep(120, signal);
        } finally {
          await this.cdp(tag, "Input.dispatchMouseEvent", {
            type: "mouseReleased",
            x: last.x,
            y: last.y,
            button: "left",
            clickCount: 1,
          });
        }
      }
      return;
    }
    throw Error("Unknown Chrome action " + kind);
  }
  async execute(
    owner: string,
    cwd: string,
    args: Obj,
    parent?: AbortSignal,
  ): Promise<any> {
    if (args.operation === "stop") {
      this.cancelled.get(owner)?.abort();
      return { stopped: true };
    }
    let target = args.tabTag;
    if (!target && args.snapshotId)
      target = [...this.observations].find(([key, observation]) => key.startsWith(owner + ":") && observation.id === args.snapshotId)?.[1].tabTag;
    if (!target && !["tabs", "open", "new_tab", "downloads", "status", "connect"].includes(args.operation) && !args.operation?.startsWith("experience_")) {
      const matches = [...this.observations].filter(([key]) => key.startsWith(owner + ":"));
      assert(matches.length === 1, "Explicit tabTag required; no active tab guessing");
      target = matches[0][1].tabTag;
    }
    return await (target ? this.tabGate(target) : this.gate).run(async () => {
      const control = new AbortController();
      this.cancelled.set(owner, control);
      const signal = AbortSignal.any([
        control.signal,
        ...(parent ? [parent] : []),
      ]);
      try {
        return await this.inner(owner, cwd, { ...args, ...(target ? { tabTag: target } : {}) }, signal);
      } finally {
        if (this.cancelled.get(owner) === control) this.cancelled.delete(owner);
      }
    });
  }
  async inner(
    owner: string,
    cwd: string,
    a: Obj,
    signal: AbortSignal,
  ): Promise<any> {
    let op =
        a.operation ||
        (a.expression
          ? "evaluate"
          : a.action || a.actions
            ? "act"
            : a.url
              ? "goto"
              : "inspect"),
      tag = a.tabTag;
    const latest = () => this.observations.get(owner + ":" + tag);
    if (!tag && a.snapshotId) {
      const match = [...this.observations].find(
        ([key, v]) => key.startsWith(owner + ":") && v.id === a.snapshotId,
      );
      tag = match?.[1].tabTag;
    }
    if (
      !tag &&
      op !== "tabs" &&
      op !== "open" &&
      op !== "new_tab" &&
      !op.startsWith("experience_") &&
      !["downloads", "status", "connect"].includes(op)
    ) {
      const matches = [...this.observations].filter(([key]) =>
        key.startsWith(owner + ":"),
      );
      assert(
        matches.length === 1,
        "Explicit tabTag required; no active tab guessing",
      );
      tag = matches[0][1].tabTag;
    }
    if (op.startsWith("experience_")) {
      const o = latest(),
        origin = o ? new URL(o.pages[0].url).origin : undefined;
      return this.experiences.execute(
        owner,
        a,
        o && origin ? { id: o.id, origin } : undefined,
      );
    }
    if (op === "run")
      return this.run(owner, cwd, { ...a, tabTag: tag }, signal);
    if (["status", "connect"].includes(op)) {
      await this.bridge.start();
      return this.bridge.status();
    }
    if (op === "downloads") return this.bridge.request(op, a, signal);
    if (op === "tabs") {
      const result = await this.bridge.request("tabs", a, signal);
      const query = String(a.query || "").toLowerCase();
      result.tabs = result.tabs.filter(
        (t: Obj) =>
          !query || (t.title + " " + t.url).toLowerCase().includes(query),
      );
      if (result.tabs.length === 1)
        return {
          ...result,
          ...(await this.feedback(
            owner,
            result.tabs[0].tag,
            a,
            "inspect",
            signal,
          )),
        };
      return result;
    }
    if (
      [
        "open",
        "new_tab",
        "goto",
        "back",
        "forward",
        "reload",
        "select_tab",
        "close_tab",
      ].includes(op)
    ) {
      const result = await this.bridge.request(
        op,
        { ...a, tabTag: tag },
        signal,
      );
      tag = result.tabTag || tag;
      if (op === "close_tab") {
        this.observations.delete(owner + ":" + tag);
        return result;
      }
      if (a.observe === "none") return result;
      if (tag) {
        let loading = true;
        const deadline = Date.now() + Math.min(a.settleMs || 1500, 5000);
        while (loading && Date.now() < deadline) {
          const tabs = await this.bridge.request("tabs", {}, signal);
          loading = tabs.tabs.find((t: Obj) => t.tag === tag)?.loading;
          if (loading) await sleep(50, signal);
        }
        return {
          ...result,
          ...(await this.feedback(
            owner,
            tag,
            a,
            a.observe || "inspect",
            signal,
          )),
        };
      }
      return result;
    }
    assert(tag, "tabTag required");
    if (op === "devtools")
      return this.bridge.request(
        op,
        { tabTag: tag, devtools: a.devtools || {} },
        signal,
      );
    if (op === "inspect" || op === "screenshot")
      return this.feedback(owner, tag, a, op, signal);
    const o = latest();
    assert(
      o,
      "Inspect this tab first; no observation is bound to this session",
    );
    if (op === "evaluate") {
      assert(
        typeof a.expression === "string" && a.expression,
        "expression required",
      );
      const frame = o.frames[a.frame || 0];
      assert(frame, "Unknown frame");
      const page = o.pages[a.frame || 0];
      const result = await this.evaluate(
        tag,
        frame,
        `__novaWebview.evaluate(${JSON.stringify(a.expression)},${JSON.stringify(page.document)},${JSON.stringify(page.url)})`,
        signal,
      );
      if (a.feedback === "none") return result;
      return {
        ...result,
        ...(await this.feedback(owner, tag, a, "inspect", signal)),
      };
    }
    assert(op === "act", "Unknown Chrome operation");
    let actions: Obj[];
    try {
      assert(!(a.action && a.actions), "Use action or actions, not both");
      const raw = a.actions || [a.action];
      assert(
        Array.isArray(raw) && raw.length >= 1 && raw.length <= 16,
        "Use1–16 actions",
      );
      actions = raw.map((v: any) =>
        normalizeAction(
          typeof v === "string"
            ? JSON.parse(v.replace(/^```(?:json)?\s*|```$/g, ""))
            : v,
        ),
      );
    } catch (e: any) {
      return {
        status: "not_executed",
        inputAttempted: false,
        completedActions: 0,
        reason: e.message,
        tabTag: tag,
        snapshotId: o.id,
      };
    }

    const progress: Obj = {
      attempted: false,
      completed: 0,
      domPreflight: false,
    };
    const before = (await this.bridge.request("tabs", {}, signal)).tabs;
    let error: string | undefined;
    for (const action of actions) {
      try {
        await this.action(o, action, a, cwd, progress, signal);
        progress.completed++;
        await this.evaluate(
          tag,
          o.frames[0],
          `__novaWebview.settle(250,${Math.min(a.settleMs || 1000, 5000)})`,
          signal,
        );
      } catch (e: any) {
        error = e.message;
        break;
      }
    }
    const after = (
      await this.bridge.request("tabs", {}, signal).catch(() => ({ tabs: [] }))
    ).tabs;
    const opened = after.filter(
      (t: Obj) => !before.some((b: Obj) => b.tag === t.tag),
    );
    let observedTag = tag;
    const active = opened.filter(
      (t: Obj) => t.active && t.controllable && t.openerTag === tag,
    );
    if (active.length === 1) observedTag = active[0].tag;
    const result: Obj = {
      status: error
        ? progress.attempted
          ? "needs_review"
          : "not_executed"
        : "executed",
      inputAttempted: progress.attempted,
      completedActions: progress.completed,
      reason: error,
      basedOnSnapshotId: o.id,
      openedTabs: opened,
      sourceTabTag: observedTag !== tag ? tag : undefined,
      scrollFeedback: progress.scrollFeedback,
      clipboard: progress.clipboard,
      verification: "unverified",
    };
    // Lyra parity: these are emitted only on failure. domPreflight stays true
    // through a click/fill's hover-verify, so a stamp/iframe-move failure counts
    // as a preflight abort even after attempted flipped on real input.
    if (error) {
      result.failedAtPreflight = !!progress.domPreflight;
      result.canReobserve = !!progress.domPreflight && progress.completed === 0;
      result.next = "先重新观察确认状态；不要重放可能已经执行的动作";
    }
    try {
      Object.assign(
        result,
        await this.feedback(owner, observedTag, a, "inspect", signal),
      );
    } catch (e: any) {
      result.observationError = e.message;
    }
    if (!error && result.pages?.length)
      this.experiences.record(
        owner,
        o.pages[0].url,
        result.pages[0].url,
        result.pages[0].title,
        actions.map((v: Obj) =>
          v.action === "fill"
            ? "填写字段（值已脱敏）"
            : v.action === "type"
              ? "输入文本（已脱敏）"
              : v.action === "press"
                ? "按 " + v.key
                : "操作 " + v.action,
        ),
      );
    return result;
  }
  async run(owner: string, cwd: string, a: Obj, signal: AbortSignal) {
    const plan = a.plan;
    assert(
      plan &&
        typeof plan.task === "string" &&
        Array.isArray(plan.steps) &&
        plan.steps.length >= 1 &&
        plan.steps.length <= 24,
      "run requires task and 1–24 steps",
    );
    let tag = a.tabTag,
      current = this.observations.get(owner + ":" + tag);
    if (!current) {
      await this.feedback(owner, tag, { visual: "none" }, "inspect", signal);
      current = this.observations.get(owner + ":" + tag);
    }
    const history: any[] = [];
    assert(
      Number.isInteger(plan.maxActions ?? 32) &&
        (plan.maxActions ?? 32) >= 1 &&
        (plan.maxActions ?? 32) <= 64,
      "maxActions must be 1–64",
    );
    let completed = 0,
      reason = "",
      result: any;
    const max = plan.maxActions || 32;
    for (const [i, step] of plan.steps.entries()) {
      if (completed >= max) {
        reason = "maxActions reached";
        break;
      }
      const o = this.observations.get(owner + ":" + tag)!;
      const visible = o.pages
          .map((p) => p.visibleText || p.text || p.fullText || "")
          .join("\n"),
        matchesText = (s: string) =>
          s
            .split("|")
            .some((v) => visible.toLowerCase().includes(v.toLowerCase()));
      if (step.when && !matchesText(step.when)) {
        reason = "when condition not satisfied";
        break;
      }
      let action: Obj;
      const needle = step.name || step.target || "";
      const candidates = o.pages
        .flatMap((p, index) =>
          p.items.map((item: Obj) => ({ ...item, frame: index })),
        )
        .filter(
          (item: Obj) =>
            (!step.role || item.role === step.role || item.tag === step.role) &&
            (!step.within || item.region?.includes(step.within)) &&
            (step.name
              ? item.name === step.name
              : (item.name + " " + item.region + " " + item.fieldContext)
                  .toLowerCase()
                  .includes(String(needle).toLowerCase())) &&
            !item.disabled,
        );
      if (step.action === "press") action = { action: "press", key: step.key };
      else if (step.action === "scroll")
        action = {
          action: "scroll",
          frame: 0,
          delta:
            step.direction === "up"
              ? -600
              : ["left", "right"].includes(step.direction)
                ? 0
                : 600,
          delta_x:
            step.direction === "left"
              ? -600
              : step.direction === "right"
                ? 600
                : 0,
        };
      else if (candidates.length === 1)
        action = {
          action: step.action,
          frame: candidates[0].frame,
          ref: candidates[0].ref,
          text:
            step.text ??
            plan.inputs?.find(
              (input: Obj) =>
                (!input.role || input.role === candidates[0].role) &&
                input.name === candidates[0].name &&
                (!input.fieldContext ||
                  candidates[0].fieldContext?.startsWith(input.fieldContext)),
            )?.text,
        };
      else {
        if (step.optional && !candidates.length) {
          history.push({ step: i + 1, skipped: true });
          completed++;
          continue;
        }
        reason = candidates.length ? "Ambiguous target" : "Target not found";
        break;
      }
      result = await this.inner(
        owner,
        cwd,
        {
          operation: "act",
          tabTag: tag,
          snapshotId: o.id,
          action,
          visual: "none",
        },
        signal,
      );
      history.push({
        step: i + 1,
        action: { ...action, text: action.text ? "[redacted]" : undefined },
        status: result.status,
        completedActions: result.completedActions,
      });
      if (result.completedActions === 1) {
        completed++;
        tag = result.tabTag || tag;
      }
      if (result.status !== "executed") {
        reason = result.reason || "Action uncertain";
        break;
      }
      const next = this.observations.get(owner + ":" + tag);
      const text =
        next?.pages
          .map((p) => p.visibleText || p.text || p.fullText || "")
          .join("\n") || "";
      if (
        (step.expect || step.expectedText) &&
        !(step.expect || step.expectedText)
          .split("|")
          .some((v: string) => text.includes(v))
      ) {
        reason = "Expected page evidence not found; input was not repeated";
        break;
      }
    }
    const latest = this.observations.get(owner + ":" + tag),
      text =
        latest?.pages.map((p) => p.fullText || p.text || "").join("\n") || "",
      done =
        completed === plan.steps.length &&
        (!plan.expectedText ||
          plan.expectedText.split("|").some((v: string) => text.includes(v)));
    if (
      latest &&
      !["none", "inspect"].includes(a.feedback) &&
      a.visual !== "none"
    ) {
      latest.id = id();
      latest.images = [];
      await this.capture(latest, a);
      this.store.save("browser-observation", latest.id, {
        ...latest,
        frames: undefined,
      });
    }
    return {
      ...result,
      snapshotId: latest?.id,
      pages: latest ? this.summarize(latest, a) : [],
      images: latest?.images || [],
      documentPath: latest
        ? "sqlite:browser-observation/" + latest.id
        : undefined,
      tabTag: tag,
      altairRun: {
        status: done ? "completed" : "needs_review",
        history,
        guided: {
          completedSteps: completed,
          totalSteps: plan.steps.length,
          remainingSteps: plan.steps.slice(completed),
          next: reason,
        },
        verification: done ? "subgoal_verified" : "unverified",
        notice:
          "run validates page evidence only; it is not user authorization or proof of business success.",
      },
    };
  }
}
