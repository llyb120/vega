}
(function installRenderTraceHookStub(host) {
    const sampleRate = "__duneRenderTraceSampleRate" in host ? host.__duneRenderTraceSampleRate : undefined;
    if (typeof sampleRate !== "number" || !(sampleRate > 0 && sampleRate <= 1))
        return;
    Object.defineProperty(host, Symbol.for("dune.render-trace.session"), {
        value: Object.freeze({ sampleRate }),
        configurable: true,
    });
    if ("__REACT_DEVTOOLS_GLOBAL_HOOK__" in host && host.__REACT_DEVTOOLS_GLOBAL_HOOK__ != null) {
        return;
    }
    const renderers = new Map();
    const noop = () => undefined;
    Object.defineProperty(host, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
        value: {
            [Symbol.for("dune.render-trace.hook-stub")]: true,
            renderers,
            supportsFiber: true,
            inject: (internals) => {
                const id = renderers.size + 1;
                renderers.set(id, internals);
                return id;
            },
            onScheduleFiberRoot: noop,
            onCommitFiberRoot: noop,
            onCommitFiberUnmount: noop,
            onPostCommitFiberRoot: noop,
        },
        configurable: true,
        enumerable: true,
        writable: true,
    });
})(globalThis)