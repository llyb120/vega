import { normalizeAction } from "./browser-actions";
import { validatePlan, literalMet, runCandidates, bindStep, chains, runState, type Candidate } from "./browser-run";
import { assertCredentialInput, credentialOrigins, vaultSite, type CredentialBinding } from "./credentials";
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
  /** File holding the full record (pages, images), written when the observation is returned. */
  documentPath?: string;
  fullPage: boolean;
  screenshot: boolean;
};

/** Default navigation settle bound while the page is still loading. */
export const NAVIGATION_SETTLE_MS = 4000;

/** Attempts at observing a tab while a navigation keeps replacing its frames or contexts. */
export const CONTEXT_RETRIES = 4;
/** CDP errors meaning the frame or its execution context went away (a navigation), not that the page failed. */
export const contextLost = (message?: string) =>
  /Cannot find context with specified id|Execution context was destroyed|No frame for given id|Cannot find default execution context|Inspected target navigated or closed/i.test(String(message || ""));

export class Chrome {
  gate = new Mutex();
  tabGates = new Map<string, Mutex>();
  tabGate(tag: string) {
    let gate = this.tabGates.get(tag);
    if (!gate) this.tabGates.set(tag, (gate = new Mutex()));
    return gate;
  }
  observations = new Map<string, Observation>();
  /** Held left-button drag across chrome_act calls (captcha sliders, etc.). */
  holds = new Map<string, { x: number; y: number }>();
  cancelled = new Map<string, AbortController>();
  experiences: Experiences;
  workspaceFile = workspaceFile;
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
    timeout?: number,
  ) {
    const control = new AbortController();
    const active = signal ? AbortSignal.any([signal, control.signal]) : control.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const request = this.cdp(tag, "Runtime.evaluate", {
        expression, contextId: frame.context, returnByValue: true, awaitPromise: true,
        ...(timeout === undefined ? {} : { timeout }),
      }, frame.session, active);
      const r = timeout === undefined ? await request : await Promise.race([
        request,
        new Promise<never>((_, reject) => { timer = setTimeout(() => {
          reject(Error("脚本等待5秒超时，可能已部分执行且异步脚本可能仍在运行；先观察确认，不要重放"));
          control.abort();
        }, timeout); }),
      ]);
      assert(!r.exceptionDetails, r.exceptionDetails?.exception?.description || r.exceptionDetails?.text || "Page evaluation failed");
      return r.result?.value;
    } finally { clearTimeout(timer); }
  }
  /**
   * Observe the tab. A navigation (redirect, SPA reload, a click that leaves the page) can destroy the frames or
   * execution contexts between resolving and using them; that is a race, not a page error: wait for the load and
   * resolve the frames again, a bounded number of times, before reporting anything.
   */
  async observe(tag: string, scope = "all", signal?: AbortSignal): Promise<Observation> {
    for (let attempt = 1; ; attempt++) {
      let o: Observation | undefined;
      try { o = await this.observeOnce(tag, scope, signal); }
      catch (error: any) { if (!contextLost(error?.message) || attempt >= CONTEXT_RETRIES) throw error; }
      if (o && (!o.coverageGaps.some(contextLost) || attempt >= CONTEXT_RETRIES)) return o;
      await this.waitForLoad(tag, 3000, signal!);
    }
  }
  private async observeOnce(
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
  /** Screenshot files go to the owner's directory: the session (task) or the user's browser view. */
  private async fileOwner(owner: string) { return owner.startsWith("browser-view:") ? owner : await this.store.session(owner); }
  /**
   * File name of an image or DOM record. The browser view only ever needs the current frame, so it overwrites one
   * file per tab (and tile); sessions keep every capture by id for read-back.
   */
  private fileName(owner: string, tag: string, id: string, slot: string) {
    return owner.startsWith("browser-view:") ? `live-${tag.replace(/[^\w-]/g, "_")}${slot}` : id + slot.replace(/^-\d+/, "");
  }
  async capture(owner: string, o: Observation, a: Obj, prior?: Observation) {
    const tag = o.tabTag,
      page = o.pages[0],
      vp = page.viewport;
    const dpr = vp.devicePixelRatio || 1;
    let region = a.region;
    const captureRef = a.ref;
    assert(!region || !captureRef, "Use region or ref, not both");
    assert(a.maxEdge === undefined || (Number.isInteger(a.maxEdge) && (a.maxEdge === 0 || (a.maxEdge >= 320 && a.maxEdge <= 3840))), "maxEdge must be 0 or 320–3840");
    if (region) assert(["x", "y", "width", "height"].every((k) => Number.isFinite(region[k]) && (k === "x" || k === "y" ? region[k] >= 0 : region[k] > 0)), "Invalid screenshot region");
    if (a.expandScroll) assert((a.frame ?? 0) === 0, "expandScroll requires frame 0");
    if (captureRef && !a.expandScroll) region = (await this.point(o, a.frame || 0, captureRef, "capture")).rect;
    let full = !region && (a.fullPage === true || !!a.expandScroll);
    let expanded: Obj | undefined, fullPageFallback: string | undefined, layout = false, resized = false;
    try {
      if (full) {
        layout = true;
        await this.evaluate(tag, o.frames[0], "__novaWebview.captureLayout(true)");
      }
      if (a.expandScroll && full) {
        let over = await this.evaluate(
            tag,
            o.frames[0],
            `__novaWebview.innerScrollOverflow(${JSON.stringify(captureRef || null)})`,
          ),
          height = vp.height;
        for (let i = 0; i < 3 && over > 1; i++) {
          const next = Math.min(16383 / dpr, height + over);
          if (next <= height) break;
          resized = true;
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
          if (after >= over - 1) {
            if (height === vp.height) await this.cdp(tag, "Emulation.clearDeviceMetricsOverride");
            else await this.cdp(tag, "Emulation.setDeviceMetricsOverride", { width: vp.width, height: Math.floor(height), deviceScaleFactor: 0, mobile: false });
            await this.evaluate(tag, o.frames[0], "__novaWebview.settle(300,1500)");
            break;
          }
          height = next;
          over = after;
        }
        expanded = { complete: over <= 1, height, viewportHeight: height };
        if (a.ref)
          region = await this.evaluate(
            tag,
            o.frames[a.frame || 0],
            `__novaWebview.documentRect(${JSON.stringify(a.ref)})`,
          );
      }
      const metrics = full ? await this.cdp(tag, "Page.getLayoutMetrics") : {};
      const documentSize = metrics.cssContentSize || metrics.contentSize || page.documentSize || {};
      let left = region?.x ?? 0, top = region?.y ?? 0;
      let width = region?.width ?? (full ? documentSize.width : vp.width);
      let totalHeight = region?.height ?? (full ? documentSize.height : vp.height);
      if (full && Math.max(width, totalHeight) * dpr > 16383) {
        assert(!a.ref, "目标区域超出截图安全上限，请改用分页或读 DOM");
        fullPageFallback = `文档 ${width}x${totalHeight} CSS像素超出整页截图安全上限，已改为视口截图`;
        if (resized) await this.cdp(tag, "Emulation.clearDeviceMetricsOverride");
        await this.evaluate(tag, o.frames[0], "__novaWebview.captureLayout(false)");
        full = false; expanded = undefined; left = 0; top = 0; width = vp.width; totalHeight = vp.height;
      }
      if (!full) {
        assert(left < vp.width && top < vp.height && left + width > 0 && top + totalHeight > 0, "region is outside the viewport");
        width = Math.min(left + width, vp.width) - Math.max(0, left);
        totalHeight = Math.min(top + totalHeight, vp.height) - Math.max(0, top);
        left = Math.max(0, left) + (vp.scrollX || 0); top = Math.max(0, top) + (vp.scrollY || 0);
      }
      assert([width, totalHeight].every((v) => Number.isFinite(v) && v > 0), "Empty screenshot region");
      o.fullPage = full;
      o.screenshot = true;
      const tileWidth = full ? Math.max(1, Math.floor(2048 / Math.max(1, dpr))) : width;
      const tileHeight = full ? Math.max(1, Math.floor(4096 / Math.max(1, dpr))) : totalHeight;
      const columns = Math.ceil(width / tileWidth), tiles = columns * Math.ceil(totalHeight / tileHeight), offset = full ? a.tileOffset ?? 0 : 0;
      assert(Number.isInteger(offset) && offset >= 0 && offset < tiles, "Invalid tileOffset");
      const maxTiles = Math.min(4, tiles - offset);
      for (let i = offset; i < offset + maxTiles; i++) {
        const dx = (i % columns) * tileWidth, dy = Math.floor(i / columns) * tileHeight;
        const x = left + dx, y = top + dy, w = Math.min(tileWidth, width - dx), h = Math.min(tileHeight, totalHeight - dy),
          clipRect = { x, y, width: w, height: h, scale: 1 };
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
        const requestedEdge = a.maxEdge ?? (a.expandScroll ? 0 : 1600);
        const original = a.expandScroll && requestedEdge === 0;
        const edge = Math.min(requestedEdge || 1568, 1568),
          scale = original ? 1 : Math.min(
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
        let imageID = o.id + "-" + o.images.length,
          unchanged = false,
          path = "";
        const imageX = full ? x : x - (vp.scrollX || 0), imageY = full ? y : y - (vp.scrollY || 0);
        const frameStream = !region && !a.expandScroll ? `${tag}:${full ? "document:" + i : "viewport"}` : undefined;
        const previous = prior?.images.find(
          (v) =>
            v.frameStream === frameStream &&
            v.x === imageX &&
            v.y === imageY &&
            v.width === w &&
            v.height === h &&
            v.pixelWidth === info.width &&
            v.pixelHeight === info.height,
        );
        if (
          frameStream && previous && prior?.fullPage === full &&
          Date.now() - prior.captured <= 180000 &&
          prior.pages[0].document === page.document &&
          typeof page.stamp === "string" && prior.pages[0].stamp === page.stamp
        ) {
          let old: Buffer | undefined;
          try { old = await this.store.files.read(previous.path); } catch {}
          if (old) {
            const [a, b] = await Promise.all([
              sharp(old).removeAlpha().raw().toBuffer(),
              sharp(data).removeAlpha().raw().toBuffer(),
            ]);
            if (
              a.length === b.length &&
              a.every((v, i) => Math.abs(v - b[i]) <= 16)
            ) {
              unchanged = true;
              imageID = previous.imageId;
              path = previous.path;
            }
          }
        }
        const fresh = !path;
        path ||= await this.store.files.write(await this.fileOwner(owner), this.fileName(owner, tag, imageID, `-${o.images.length}.webp`), data);
        o.images.push({
          imageId: imageID,
          snapshotId: o.id,
          path,
          // An overwritten browser-view frame gets a new address so caches never show the previous one.
          url: fresh ? this.store.files.url(path) + (owner.startsWith("browser-view:") ? "?v=" + o.id : "") : previous!.url,
          x: imageX,
          y: imageY,
          width: w,
          height: h,
          pixelWidth: info.width,
          pixelHeight: info.height,
          tile: full ? i : undefined,
          frameStream,
          unchanged,
          readOnlyImage: !!a.expandScroll,
        });
      }
      return {
        fullPage: full,
        scrollExpanded: expanded,
        fullPageFallback,
        documentSize: full ? { width, height: totalHeight } : undefined,
        totalTiles: tiles,
        screenshotComplete: offset === 0 && offset + maxTiles === tiles,
        nextTile: offset + maxTiles < tiles ? offset + maxTiles : undefined,
      };
    } finally {
      const errors: string[] = [];
      if (resized) await this.cdp(tag, "Emulation.clearDeviceMetricsOverride").catch((e) => errors.push(e.message));
      if (layout) {
        await this.cdp(tag, "Page.captureScreenshot", { format: "webp", quality: 100, captureBeyondViewport: false }).catch((e) => errors.push(e.message));
        await this.evaluate(tag, o.frames[0], "__novaWebview.captureLayout(false)").catch((e) => errors.push(e.message));
      }
      if (errors.length) throw Error("截图后恢复页面布局失败，请重新观察：" + errors.join("; "));
    }
  }
  summarize(o: Observation, a: Obj) {
    // Summary only (documentPath keeps the full record): drop what is derivable or a default.
    // nodeId = page.document + ":" + the part of ref after "."; documentRect = viewportRect + page.viewport scrollX/scrollY.
    const compactItem = (v: Obj) => {
      const { nodeId: _node, documentRect: _rect, ...item } = v;
      for (const key of ["actionable", "disabled", "editable", "password"]) if (item[key] === false) delete item[key];
      for (const key of ["value", "fieldContext"]) if (item[key] === "") delete item[key];
      return item;
    };
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
        items: items.map(compactItem),
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
      prior = this.observations.get(key);
    const capture =
      mode === "screenshot" ||
      a.feedback === "screenshot" ||
      (!["none", "inspect"].includes(a.feedback) && a.visual !== "none");
    assert(mode === "screenshot" || (!a.ref && !a.region), "inspect does not accept region/ref; use screenshot");
    let shot: Obj = {}, o: Observation;
    for (let attempt = 1; ; attempt++) {
      o = await this.observe(tag, a.scope || "all", signal);
      shot = {};
      if (!capture) break;
      try { shot = await this.capture(owner, o, mode === "screenshot" ? a : { ...a, fullPage: false, expandScroll: false }, prior); break; }
      catch (error: any) {
        // The page navigated between observing and capturing: observe the new document instead.
        if (contextLost(error?.message) && attempt < CONTEXT_RETRIES) { await this.waitForLoad(tag, 3000, signal!); continue; }
        if (mode === "screenshot" || a.feedback === "screenshot") throw error;
        o.screenshot = false; o.images = [];
        shot = { screenshotError: error.message };
        break;
      }
    }
    o.documentPath = await this.store.files.write(await this.fileOwner(owner), this.fileName(owner, tag, o.id, ".json"), JSON.stringify({ ...o, frames: undefined }));
    this.observations.set(key, o);
    const origin = new URL(o.pages[0].url).origin;
    // Identifiers and images first: an oversized result is clipped from the end, never these.
    return {
      browser: "chrome",
      tabTag: tag,
      snapshotId: o.id,
      images: o.images,
      ...shot,
      documentPath: o.documentPath,
      coverageGaps: o.coverageGaps,
      experienceHint: await this.experiences.hint(owner, origin),
      pages: this.summarize(o, a),
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
  private async credentialInput(tag: string, frame: Frame | undefined, text: unknown, credentials: CredentialBinding[], signal: AbortSignal) {
    const origins = credentialOrigins(text, credentials);
    if (!origins.length) return;
    assert(frame, "Unknown credential input frame");
    const url = await this.evaluate(tag, frame, "location.href", signal);
    const site = vaultSite(url);
    assert(origins.every((allowed) => allowed.has(site)), "凭据尚未针对当前页面核对或已切换认证页面，已阻止这次凭据写入；请先观察实际页面（含 SSO / 子框架）再重新 vault_get 核对使用条件，无需补网站配置，不要跨系统试用账号。");
  }

  async releaseHold(tag: string) {
    const hold = this.holds.get(tag);
    if (!hold) return;
    this.holds.delete(tag);
    await this.cdp(tag, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: hold.x,
      y: hold.y,
      button: "left",
      clickCount: 1,
    }).catch(() => {});
  }
  private async glide(tag: string, from: { x: number; y: number }, to: { x: number; y: number }, duration: number, signal: AbortSignal, held: boolean) {
    const steps = Math.max(5, Math.min(24, Math.floor(duration / 16)));
    let last = from;
    for (let i = 1; i <= steps; i++) {
      signal.throwIfAborted();
      last = { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps };
      await this.cdp(tag, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        ...last,
        ...(held ? { button: "left", buttons: 1 } : {}),
      });
      await sleep(duration / steps, signal);
    }
    return last;
  }
  private coordinateImage(o: Observation, imageId?: string) {
    const image = o.images.find((i) => i.imageId === imageId) || o.images[0];
    assert(!image?.readOnlyImage, "Expanded screenshots are read-only");
    if (image) return image;
    const { width, height } = o.pages[0].viewport;
    return { x: 0, y: 0, width, height, pixelWidth: width, pixelHeight: height };
  }
  private async preflight(o: Observation, actions: Obj[], top: Obj, cwd: string) {
    for (const action of actions) {
      if (["click", "hover", "fill", "scroll"].includes(action.action) && action.ref) {
        const frame = o.pages.findIndex((p) => p.items?.some((v: Obj) => v.ref === action.ref));
        assert(frame >= 0, "ref not found in observed frames; never fabricate refs");
        action.frame = frame;
      } else if (action.action === "scroll") assert(action.frame === 0, "子框架滚动需要明确 ref");
      if (action.action === "upload") {
        assert(o.frames[action.frame], "upload.frame is not in the observation");
        action.files = await Promise.all(action.files.map((path: string) => this.workspaceFile(cwd, path)));
      }
      if (["click_at", "move", "drag", "scroll_at"].includes(action.action)) {
        const image = this.coordinateImage(o, top.imageId);
        if (action.action === "drag") assert(!o.fullPage, "Drag requires viewport screenshot");
        for (const [x, y] of action.action === "drag" ? [[action.x, action.y], [action.to_x, action.to_y]] : [[action.x, action.y]])
          assert(x < image.pixelWidth && y < image.pixelHeight, "Coordinates outside image or viewport");
      }
    }
  }
  /**
   * After open/goto/back/forward/reload/select: wait while the tab is loading or its document is not
   * complete, bounded by settleMs (0 or omitted = 4000 ms). Long-polling or streaming pages simply hit the bound.
   * Returns the last tab list.
   */
  async settleNavigation(tag: string, settleMs: number | undefined, signal: AbortSignal) {
    const deadline = Date.now() + Math.min(settleMs || NAVIGATION_SETTLE_MS, 5000);
    let tabs: Obj[] | undefined;
    for (;;) {
      tabs = (await this.bridge.request("tabs", {}, signal)).tabs;
      const tab = tabs?.find((t: Obj) => t.tag === tag);
      let loading = !!tab?.loading;
      if (tab && !loading) {
        // A tab can stop "loading" while the document is still interactive (SPA bootstrap, redirects).
        const state = await this.cdp(tag, "Runtime.evaluate", { expression: "document.readyState", returnByValue: true }, undefined, signal)
          .then((r: Obj) => r?.result?.value, () => "complete");
        loading = typeof state === "string" && state !== "complete";
      }
      if (!loading || Date.now() >= deadline) return tabs;
      await sleep(Math.min(100, Math.max(0, deadline - Date.now())), signal);
    }
  }
  private async waitForLoad(tag: string, ms: number, signal: AbortSignal) {
    const deadline = Date.now() + ms;
    if (ms > 0) await sleep(Math.min(120, ms), signal);
    do {
      const { tabs } = await this.bridge.request("tabs", {}, signal);
      const tab = tabs.find((v: Obj) => v.tag === tag);
      if (!tab || !tab.loading) return;
      if (Date.now() >= deadline) return;
      await sleep(Math.min(200, deadline - Date.now()), signal);
    } while (Date.now() < deadline);
  }
  async action(
    o: Observation,
    a: Obj,
    top: Obj,
    cwd: string,
    progress: Obj,
    signal: AbortSignal,
    credentials: CredentialBinding[] = [],
  ) {
    signal.throwIfAborted();
    const tag = o.tabTag,
      kind = a.action || a.type;
    let frameIndex = a.frame ?? 0;
    if (["click", "hover", "fill", "scroll"].includes(kind) && a.ref) {
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
    if (kind === "fill") await this.credentialInput(tag, frame, a.text, credentials, signal);
    if (kind === "type") assertCredentialInput(a.text);
    const changed = () => { signal.throwIfAborted(); progress.attempted = true; };
    if (kind === "wait") {
      assert(
        Number.isInteger(a.ms) && a.ms >= 0 && a.ms <= 10000,
        "wait is 0–10000ms",
      );
      await sleep(a.ms, signal);
      return;
    }
    if (["click", "hover", "fill", "scroll"].includes(kind)) {
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
      progress.domPreflight = false;
      // hover: the pointer stays on the verified element; tooltips and menus show in the following observation.
      if (kind === "hover") return;
      signal.throwIfAborted();
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
        signal.throwIfAborted();
        await this.key(tag, "Control+A");
        await requireFocus();
        await this.credentialInput(tag, frame, a.text, credentials, signal);
        signal.throwIfAborted();
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
        a.files.map((p: string) => this.workspaceFile(cwd, p)),
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
            await this.credentialInput(tag, f, a.text, credentials, signal);
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
    if (["click_at", "move", "drag", "pointer", "scroll_at"].includes(kind)) {
      const image = this.coordinateImage(o, top.imageId);
      const map = (x: number, y: number) => {
        assert(
          Number.isFinite(x) &&
            Number.isFinite(y) &&
            x >= 0 &&
            y >= 0 &&
            x < image.pixelWidth &&
            y < image.pixelHeight,
          "Coordinates outside image or viewport",
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
        `__novaWebview.coordinate(${xy.x},${xy.y},${o.fullPage})`,
      );
      changed();
      const holding = this.holds.has(tag);
      if (holding && kind !== "pointer")
        assert(false, "已有分段拖拽未松开，请先 pointer.up / pointer.move，不要穿插其他坐标动作");
      // pointer move/up glides from the held point; skip a teleporting mouseMoved that would jump the slider.
      const skipHoverMove = kind === "pointer" && a.phase !== "down";
      if (!skipHoverMove) {
        await this.cdp(tag, "Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: p.x,
          y: p.y,
          ...(holding ? { button: "left", buttons: 1 } : {}),
        });
        if (p.hoverTarget && !holding) {
          await this.evaluate(
            tag,
            o.frames[0],
            `__novaWebview.verifyPoint(${JSON.stringify(p.hoverTarget.ref)},${p.x},${p.y},${JSON.stringify(p.hoverTarget.rect)})`,
          );
        }
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
        assert(!this.holds.has(tag), "已有分段拖拽未松开，请先 pointer.up 或继续 pointer.move");
        const end = await this.evaluate(tag, o.frames[0], `__novaWebview.coordinate(${map(a.to_x, a.to_y).x},${map(a.to_x, a.to_y).y},${o.fullPage})`);
        const duration = a.duration_ms ?? 160;
        assert(duration >= 80 && duration <= 1500, "Drag duration 80–1500ms");
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
          last = await this.glide(tag, p, end, duration, signal, true);
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
      } else if (kind === "pointer") {
        // Segmented hold-drag: down keeps the button held across chrome_act calls so captchas can be nudged after each observation.
        assert(!o.fullPage, "pointer requires viewport screenshot");
        const hold = this.holds.get(tag);
        const duration = a.duration_ms ?? 160;
        if (a.phase === "down") {
          assert(!hold, "已在按住拖拽中，请先 pointer.up 或 pointer.move");
          await this.cdp(tag, "Input.dispatchMouseEvent", {
            type: "mousePressed",
            x: p.x,
            y: p.y,
            button: "left",
            buttons: 1,
            clickCount: 1,
          });
          await sleep(80, signal);
          this.holds.set(tag, { x: p.x, y: p.y });
        } else if (a.phase === "move") {
          assert(hold, "尚未 pointer.down，无法分段拖动");
          assert(duration >= 80 && duration <= 1500, "Drag duration 80–1500ms");
          const last = await this.glide(tag, hold, p, duration, signal, true);
          this.holds.set(tag, { x: last.x, y: last.y });
        } else {
          assert(hold, "尚未 pointer.down，无法松开");
          if (hold.x !== p.x || hold.y !== p.y) {
            assert(duration >= 80 && duration <= 1500, "Drag duration 80–1500ms");
            const last = await this.glide(tag, hold, p, duration, signal, true);
            hold.x = last.x; hold.y = last.y;
          }
          this.holds.delete(tag);
          await this.cdp(tag, "Input.dispatchMouseEvent", {
            type: "mouseReleased",
            x: hold.x,
            y: hold.y,
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
    credentials: CredentialBinding[] = [],
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
        return await this.inner(owner, cwd, { ...args, ...(target ? { tabTag: target } : {}) }, signal, credentials);
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
    credentials: CredentialBinding[] = [],
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
      return await this.experiences.execute(
              owner,
              a,
              o && origin ? { id: o.id, origin } : undefined,
            );
    }
    if (op === "run")
      return this.run(owner, cwd, { ...a, tabTag: tag }, signal, credentials);
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
      if (["close_tab", "goto", "back", "forward", "reload"].includes(op)) {
        await this.releaseHold(tag);
        for (const [key, observation] of this.observations)
          if (observation.tabTag === tag) this.observations.delete(key);
      }
      if (op === "close_tab") return result;
      if (a.observe === "none") return result;
      if (tag) {
        const tabs = await this.settleNavigation(tag, a.settleMs, signal);
        return {
          ...result,
          // The bridge listed tabs as the navigation started; report them as they are after settling.
          ...(tabs && result.tabs ? { tabs } : {}),
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
    const script = op === "evaluate";
    assert(script || op === "act", "Unknown Chrome operation");
    if (script) {
      assert(typeof a.expression === "string" && a.expression.trim() && a.expression.length <= 65536, "expression required, at most 64K characters");
      assert(Number.isInteger(a.frame ?? 0) && o.frames[a.frame ?? 0], "Unknown frame");
      await this.credentialInput(tag, o.frames[a.frame ?? 0], a.expression, credentials, signal);
    }
    let actions: Obj[] = [];
    const settleMs = a.settleMs ?? 1500;
    try {
      assert(Number.isInteger(settleMs) && settleMs >= 0 && settleMs <= 4000, "settleMs must be 0–4000");
      if (!script) {
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
      for (const action of actions) if (["fill", "type"].includes(action.action)) assertCredentialInput(action.text);
      await this.preflight(o, actions, a, cwd);
      }
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
    let error: string | undefined, value: unknown, opened: Obj[] = [], tabDiscoveryError: string | undefined;
    const discover = async () => {
      const { tabs } = await this.bridge.request("tabs", {}, signal);
      const found = tabs.filter((t: Obj) => t.openerTag === tag && !before.some((b: Obj) => b.tag === t.tag));
      if (found.length) opened = found;
    };
    if (script) {
      try {
        const index = a.frame ?? 0, page = o.pages[index];
        progress.attempted = true;
        const outcome = await this.evaluate(tag, o.frames[index],
          `__novaWebview.evaluate(${JSON.stringify(a.expression)},${JSON.stringify(page.document)},${JSON.stringify(page.url)})`, signal, 5000);
        if (outcome?.status === "executed") { progress.completed = 1; value = outcome.value; }
        else {
          progress.attempted = outcome?.status !== "not_executed";
          error = outcome?.reason || "脚本结果未知，请观察确认，不要重放";
        }
      } catch (e: any) { error = e.message; }
    }
    for (const [index, action] of actions.entries()) {
      try {
        await this.action(o, action, a, cwd, progress, signal, credentials);
        progress.completed++;
        if (index + 1 < actions.length) {
          await discover();
          if (opened.length) { error = "动作已打开新标签页或窗口，余下动作未执行"; break; }
        }
      } catch (e: any) { error = e.message; break; }
    }
    if (progress.attempted) await discover().catch((e) => { tabDiscoveryError = e.message; });
    const child = opened.length === 1 && opened[0].active && opened[0].controllable && opened[0].allowed !== false ? opened[0].tag : undefined;
    const observedTag = child || tag;
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
      sourceTabTag: opened.length ? tag : undefined,
      tabTag: tag,
      tabDiscoveryError,
      ...(script && progress.completed ? { value } : {}),
      scrollFeedback: progress.scrollFeedback,
      clipboard: progress.clipboard,
      verification: "unverified",
    };
    // Lyra parity: these are emitted only on failure. domPreflight stays true
    // through a click/fill's hover-verify, so an iframe-move failure counts
    // as a preflight abort even after attempted flipped on real input.
    if (error) {
      result.failedAtPreflight = !!progress.domPreflight;
      result.canReobserve = !!progress.domPreflight && progress.completed === 0;
      result.next = "先重新观察确认状态；不要重放可能已经执行的动作";
    }
    if ((!script || a.feedback !== "none") && (!opened.length || child)) {
      try {
        if (settleMs > 0 && (opened.length || script || actions.some((v) => ["click", "click_at", "press", "hover"].includes(v.action)))) {
          await this.waitForLoad(observedTag, settleMs, signal);
          if (observedTag === tag) await this.evaluate(tag, o.frames[0], `__novaWebview.settle(250,${Math.min(settleMs, 1000)})`, signal).catch(() => {});
        }
        const feedback: Obj = { ...a, fullPage: false };
        for (const key of ["ref", "frame", "region", "expandScroll", "tileOffset"]) delete feedback[key];
        Object.assign(result, await this.feedback(owner, observedTag, feedback, "inspect", signal));
      } catch (e: any) { result.observationError = e.message; }
    }
    if (!script && !error && result.pages?.length)
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
    // pages last: an oversized result is clipped from the end, keeping status and images.
    const { pages, ...head } = result;
    return pages === undefined ? head : { ...head, pages };
  }
  async run(owner: string, cwd: string, a: Obj, parent: AbortSignal, credentials: CredentialBinding[] = []) {
    const plan = a.plan;
    validatePlan(plan);
    for (const input of [...plan.steps, ...(plan.inputs || [])]) assertCredentialInput(input.text);
    const signal = AbortSignal.any([parent, AbortSignal.timeout(180000)]);
    let tag = a.tabTag, result: Obj = {}, completed = 0, executed = 0, reason = "", preflightRetries = 0;
    const history: Obj[] = [], checks: Obj[] = [], used = new Set<string>(), stateActions = new Map<string, number>();
    let baseline: Set<string> | undefined;
    const observation = () => this.observations.get(owner + ":" + tag);
    const refresh = async () => {
      signal.throwIfAborted();
      Object.assign(result, await this.feedback(owner, tag, { visual: "none", scope: "viewport" }, "inspect", signal));
      delete result.observationError;
    };
    if (!observation()) await refresh();
    const initialURL = new URL(observation()!.pages[0].url);
    assert(["http:", "https:"].includes(initialURL.protocol), "run only supports HTTP(S) pages");
    const home = initialURL.origin;
    const pages = () => {
      signal.throwIfAborted();
      const current = observation();
      assert(current, "Missing run observation");
      assert(new URL(current.pages[0].url).origin === home, "页面跨站，需主模型重新确认授权；后续步骤未执行");
      return current.pages;
    };
    const verify = async (expect: string, step: number, ms: number) => {
      const started = Date.now();
      for (;;) {
        const current = pages(), met = !current.some((p) => p.loading) && literalMet(current, expect);
        if (met || Date.now() - started >= ms) {
          checks.push({ step: step + 1, expect, met, ms: Date.now() - started });
          return met;
        }
        await sleep(250, signal); await refresh();
      }
    };
    const perform = async (batch: Candidate[], state: string, reveal = false) => {
      assert(executed + batch.length <= (plan.maxActions ?? 32), "maxActions reached");
      const count = (stateActions.get(state) || 0) + 1;
      assert(count <= 3, "同一页面状态已多次操作仍未推进，交回主模型");
      assert(batch.every((c) => !used.has(state + c.key)), "同一页面状态的动作不会重放，请重新规划");
      stateActions.set(state, count);
      for (const c of batch) used.add(state + c.key);
      baseline = new Set(runCandidates(pages()).map((c) => c.loose));
      result = await this.inner(owner, cwd, { operation: "act", tabTag: tag, snapshotId: observation()!.id,
        actions: batch.map((c) => c.action), feedback: "inspect", visual: "none", scope: "viewport" }, signal, credentials);
      const done = Math.min(result.completedActions || 0, batch.length);
      executed += done;
      history.push({ step: completed + 1, reveal, actions: batch.map((c) => ({ ...c.action, ...(c.action.text !== undefined ? { text: "[redacted]" } : {}) })),
        status: result.status, completedActions: done, reason: result.reason });
      if (!reveal) completed += done;
      tag = result.tabTag || tag;
      assert(!result.openedTabs?.length, "操作打开新标签页，已停止后续步骤；按 openedTabs 确认目标，不重放已执行步骤");
      if (result.failedAtPreflight && preflightRetries++ < 3 && (done > 0 || result.canReobserve)) {
        // A DOM preflight failure sent no press/type for the failed step; completed steps stay consumed.
        for (const c of batch.slice(done)) used.delete(state + c.key);
        if (!done) stateActions.set(state, count - 1);
        await refresh(); return false;
      }
      assert(result.status === "executed", result.reason || "Action uncertain; do not replay");
      if (result.observationError || !result.snapshotId) await refresh();
      pages();
      preflightRetries = 0;
      return true;
    };
    try {
      let started = Date.now(), repeats = 0, revealed = 0, whenChecked = -1, loadingSince: number | undefined;
      while (completed < plan.steps.length) {
        const index = completed, step = plan.steps[index];
        assert(executed < (plan.maxActions ?? 32), "maxActions reached");
        if (whenChecked !== index) {
          if (step.when) assert(await verify(step.when, index, 3000), "when condition not satisfied; this step was not executed");
          whenChecked = index;
        }
        const current = pages();
        if (current.some((p) => p.loading)) {
          loadingSince ??= Date.now();
          if (Date.now() - loadingSince < 4000) { await sleep(250, signal); await refresh(); continue; }
        } else loadingSince = undefined;
        const state = runState(current), all = runCandidates(current).map((c) => ({ ...c, fresh: !!baseline && !baseline.has(c.loose) }));
        const available = all.filter((c) => !used.has(state + c.key));
        const bound = bindStep(step, plan.inputs || [], available);
        assert(!bound.ambiguous, "Ambiguous target; specify name/within/role");
        if (!bound.candidate) {
          if (Date.now() - started < 3000) { await sleep(250, signal); await refresh(); continue; }
          const down = available.find((c) => c.action.action === "scroll" && !c.action.ref && c.action.delta > 0);
          if (revealed < 2 && step.action !== "scroll" && down) { revealed++; await perform([down], state, true); continue; }
          if (step.optional) { history.push({ step: index + 1, skipped: true }); completed++; started = Date.now(); revealed = 0; repeats = 0; continue; }
          throw Error("Target not found; replan against the latest observation");
        }
        const batch = [bound.candidate];
        while (batch.length < 8 && index + batch.length < plan.steps.length && executed + batch.length < (plan.maxActions ?? 32)) {
          const next = plan.steps[index + batch.length];
          if (!chains(plan.steps[index + batch.length - 1], batch.at(-1)!, next)) break;
          const candidate = bindStep(next, plan.inputs || [], available).candidate;
          if (!candidate || (candidate.action.ref && batch.some((b) => b.action.ref === candidate.action.ref))) break;
          batch.push(candidate);
        }
        if (!await perform(batch, state)) continue;
        const last = index + batch.length - 1, finalStep = plan.steps[last], expect = finalStep.expect || finalStep.expectedText;
        if (expect && !await verify(expect, last, 6000)) {
          if (repeats < (finalStep.repeat || 0)) { repeats++; completed = last; started = Date.now(); revealed = 0; continue; }
          throw Error("Expected page evidence not found; completed input was not repeated");
        }
        repeats = 0; revealed = 0; started = Date.now();
      }
      if (plan.expectedText) assert(await verify(plan.expectedText, completed, 6000), "Final expectedText not satisfied");
    } catch (error: any) { reason = error.message; }
    // Use normal feedback so the final image keeps the same access grants and observation ownership.
    if (observation() && !result.openedTabs?.length && !["none", "inspect"].includes(a.feedback) && a.visual !== "none" && !signal.aborted) {
      try { Object.assign(result, await this.feedback(owner, tag, { ...a, fullPage: false }, "inspect", signal)); }
      catch (error: any) { result.observationError = error.message; }
    }
    const latest = result.openedTabs?.length && !result.snapshotId ? undefined : observation();
    const done = !reason && completed === plan.steps.length;
    const { pages: _pages, snapshotId: _snapshot, images: _images, documentPath: _document, tabTag: _tag, ...rest } = result;
    // Identifiers and images first, pages last: an oversized result is clipped from the end.
    return {
      snapshotId: latest?.id, images: latest?.images || [],
      documentPath: latest?.documentPath, tabTag: tag,
      ...rest,
      altairRun: {
        status: done ? "completed" : "needs_review", history, checks, executedActions: executed,
        guided: { completedSteps: completed, totalSteps: plan.steps.length, remainingSteps: plan.steps.slice(completed), next: reason },
        verification: done && plan.expectedText ? "subgoal_verified" : "unverified",
        notice: "run validates page evidence only; it is not user authorization or proof of business success.",
      },
      pages: latest ? this.summarize(latest, a) : [],
    };
  }
}
