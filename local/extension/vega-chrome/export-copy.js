// Only the generated server-private manifest references this script, on explicitly enabled export origins.
(() => {
  if (window !== top || !isSecureContext || typeof window.showSaveFilePicker !== 'function') return;
  window.showSaveFilePicker = async ({ suggestedName } = {}) => {
    if (!navigator.userActivation.isActive) throw new DOMException('保存副本需要用户点击', 'SecurityError');
    const name = String(suggestedName || 'download').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
    let opened = false;
    // shortcut: new, single-use export copies only; persistent/edit-in-place handles need site-specific support.
    return Object.freeze({ kind: 'file', name, async createWritable(options = {}) {
      if (opened || options.keepExistingData) throw new DOMException('仅支持一次性导出新副本', 'NotSupportedError');
      opened = true;
      const dir = await navigator.storage.getDirectory(), tmp = `vega-export-${crypto.randomUUID()}`;
      const handle = await dir.getFileHandle(tmp, { create: true });
      const clean = () => dir.removeEntry(tmp).catch(() => {});
      let file;
      try { file = await handle.createWritable(); } catch (error) { await clean(); throw error; }
      const stream = new WritableStream({
        async write(chunk) {
          try { await file.write(chunk); }
          catch (error) { await file.abort().catch(() => {}); await clean(); throw error; }
        },
        async abort(reason) { try { await file.abort(reason); } finally { await clean(); } },
        async close() {
          try {
            await file.close();
            // Detach the blob from OPFS before removing the temporary file; Chrome fetches the URL asynchronously.
            const blob = await new Response((await handle.getFile()).stream()).blob();
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob); a.download = name;
            try { a.click(); } finally { const url = a.href; setTimeout(() => URL.revokeObjectURL(url), 60000); }
          } finally { await clean(); }
        },
      });
      const write = async chunk => {
        const writer = stream.getWriter();
        try { await writer.write(chunk); } finally { writer.releaseLock(); }
      };
      return Object.assign(stream, { write, seek: position => write({ type: 'seek', position }), truncate: size => write({ type: 'truncate', size }) });
    } });
  };
})();
