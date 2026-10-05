/** Browser init script. No strong references to detached DOM/canvas/listener owners. */
export function installMobileLifecycleProbe() {
  const native = {
    raf: requestAnimationFrame.bind(window), cancelRaf: cancelAnimationFrame.bind(window),
    timeout: setTimeout.bind(window), clearTimeout: clearTimeout.bind(window),
    interval: setInterval.bind(window), clearInterval: clearInterval.bind(window),
    add: EventTarget.prototype.addEventListener, remove: EventTarget.prototype.removeEventListener,
  };
  const frames = new Map(), timeouts = new Map(), intervals = new Map();
  const metadata = () => ({label: window.__lifeLabel || 'framework', stack: new Error().stack?.split('\n').slice(3, 7).join('\n')});
  let frameCallbacks = 0, timerCallbacks = 0, callbackSequence = 0;
  const callbacks = [];
  const recordCallback = (kind, detail) => callbacks.push({sequence: ++callbackSequence, kind, ...detail});
  window.requestAnimationFrame = callback => {
    let id = native.raf(time => { recordCallback('raf', frames.get(id)); frames.delete(id); frameCallbacks++; callback(time); });
    frames.set(id, metadata()); return id;
  };
  window.cancelAnimationFrame = id => { frames.delete(id); return native.cancelRaf(id); };
  window.setTimeout = (callback, delay, ...args) => {
    if (typeof callback !== 'function') throw new Error('Lifecycle probe does not support string timers');
    let id = native.timeout(() => { recordCallback('timeout', timeouts.get(id)); timeouts.delete(id); timerCallbacks++; callback(...args); }, delay);
    timeouts.set(id, {...metadata(), delay}); return id;
  };
  window.setInterval = (callback, delay, ...args) => {
    if (typeof callback !== 'function') throw new Error('Lifecycle probe does not support string timers');
    const id = native.interval(() => { recordCallback('interval', intervals.get(id)); timerCallbacks++; callback(...args); }, delay);
    intervals.set(id, {...metadata(), delay}); return id;
  };
  const clear = id => { timeouts.delete(id); intervals.delete(id); };
  window.clearTimeout = id => { clear(id); return native.clearTimeout(id); };
  window.clearInterval = id => { clear(id); return native.clearInterval(id); };

  let nextListener = 1;
  const listeners = new Map(), targetListeners = new WeakMap();
  const captureOf = options => typeof options === 'boolean' ? options : Boolean(options?.capture);
  function forget(record) {
    if (!record.active) return;
    record.active = false; listeners.delete(record.id);
    if (record.abort) {
      const signal = record.signal?.deref();
      if (signal) native.remove.call(signal, 'abort', record.abort);
      record.abort = null;
    }
  }
  EventTarget.prototype.addEventListener = function(type, callback, options) {
    if (!callback) return native.add.call(this, type, callback, options);
    const capture = captureOf(options), signal = typeof options === 'object' ? options?.signal : null;
    if (signal?.aborted) return native.add.call(this, type, callback, options);
    let records = targetListeners.get(this);
    if (!records) targetListeners.set(this, records = []);
    const existing = records.find(record => record.active && record.type === type && record.capture === capture && record.callback.deref() === callback);
    if (existing) return native.add.call(this, type, existing.wrapper.deref(), options);
    const record = {id: nextListener++, target: new WeakRef(this), callback: new WeakRef(callback), type, capture, active: true, ...metadata()};
    const once = Boolean(typeof options === 'object' && options?.once);
    const wrapped = function(event) {
      if (once) forget(record);
      if (typeof callback === 'function') return callback.call(this, event);
      return callback.handleEvent(event);
    };
    record.wrapper = new WeakRef(wrapped);
    native.add.call(this, type, wrapped, options);
    records.push(record); listeners.set(record.id, record);
    if (signal) {
      record.signal = new WeakRef(signal); record.abort = () => forget(record);
      native.add.call(signal, 'abort', record.abort, {once: true});
    }
  };
  EventTarget.prototype.removeEventListener = function(type, callback, options) {
    const record = targetListeners.get(this)?.find(item => item.active && item.type === type && item.capture === captureOf(options) && item.callback.deref() === callback);
    if (!record) return native.remove.call(this, type, callback, options);
    const wrapped = record.wrapper.deref(); forget(record);
    return native.remove.call(this, type, wrapped || callback, options);
  };
  const observers = [], NativeRO = window.ResizeObserver;
  if (NativeRO) window.ResizeObserver = class extends NativeRO {
    constructor(callback) {
      super(callback); this.__lifeTargets = new Set();
      this.__lifeRecord = {observer: new WeakRef(this), label: window.__lifeLabel || 'framework', targets: 0}; observers.push(this.__lifeRecord);
    }
    observe(target, options) { super.observe(target, options); this.__lifeTargets.add(target); this.__lifeRecord.targets = this.__lifeTargets.size; }
    unobserve(target) { super.unobserve(target); this.__lifeTargets.delete(target); this.__lifeRecord.targets = this.__lifeTargets.size; }
    disconnect() { super.disconnect(); this.__lifeTargets.clear(); this.__lifeRecord.targets = 0; }
  };
  const workers = [], NativeWorker = window.Worker;
  if (NativeWorker) window.Worker = class extends NativeWorker {
    constructor(...args) { super(...args); this.__lifeRecord = {worker: new WeakRef(this), url: String(args[0]), terminated: false}; workers.push(this.__lifeRecord); }
    terminate() { this.__lifeRecord.terminated = true; return super.terminate(); }
  };
  const urls = new Set(), createURL = URL.createObjectURL.bind(URL), revokeURL = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = object => { const url = createURL(object); urls.add(url); return url; };
  URL.revokeObjectURL = url => { urls.delete(String(url)); return revokeURL(url); };

  const captures = new Map(), setCapture = Element.prototype.setPointerCapture, releaseCapture = Element.prototype.releasePointerCapture;
  Element.prototype.setPointerCapture = function(id) { setCapture.call(this, id); captures.set(id, new WeakRef(this)); };
  Element.prototype.releasePointerCapture = function(id) { releaseCapture.call(this, id); captures.delete(id); };
  native.add.call(document, 'lostpointercapture', event => captures.delete(event.pointerId), true);
  const inputs = [];
  native.add.call(document, 'pointerdown', event => inputs.push({type: event.type, trusted: event.isTrusted, pointerType: event.pointerType, label: window.__lifeLabel, at: performance.now()}), true);

  const canvases = [], canvasRecords = new WeakMap(), contextRecords = new WeakMap(), glRecords = [];
  const context = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(kind, ...args) {
    const result = context.call(this, kind, ...args);
    if (result) {
      let record = canvasRecords.get(this);
      if (!record) { record = {canvas: new WeakRef(this), kind, draws: 0, label: window.__lifeLabel || 'framework'}; canvasRecords.set(this, record); canvases.push(record); }
      contextRecords.set(result, record);
      if ((kind === 'webgl' || kind === 'webgl2' || kind === 'experimental-webgl') && !glRecords.some(item => item.context.deref() === result))
        glRecords.push({context: new WeakRef(result), canvas: new WeakRef(this), kind, counts: {}, label: record.label});
    }
    return result;
  };
  for (const method of ['drawImage', 'fillRect', 'clearRect', 'fill', 'stroke']) {
    const original = CanvasRenderingContext2D.prototype[method];
    CanvasRenderingContext2D.prototype[method] = function(...args) { const record = contextRecords.get(this); if (record) record.draws++; return original.apply(this, args); };
  }
  const handles = new WeakMap();
  for (const Constructor of [window.WebGLRenderingContext, window.WebGL2RenderingContext].filter(Boolean)) {
    for (const name of ['Buffer', 'Texture', 'Program', 'Framebuffer', 'Renderbuffer', 'VertexArray', 'Shader']) {
      // WebGL2 inherits several WebGL1 functions in some engines. Patch each own implementation once.
      const proto = Constructor.prototype, create = proto['create' + name], remove = proto['delete' + name];
      if (!create || create.__lifeWrapped) continue;
      const wrapped = function(...args) {
        const value = create.apply(this, args), record = glRecords.find(item => item.context.deref() === this);
        if (value && record) { record.counts[name] = (record.counts[name] || 0) + 1; handles.set(value, {record, name}); }
        return value;
      };
      wrapped.__lifeWrapped = true; proto['create' + name] = wrapped;
      proto['delete' + name] = function(value) { const record = value && handles.get(value); if (record) { record.record.counts[record.name]--; handles.delete(value); } return remove.call(this, value); };
    }
  }
  const animations = () => document.getAnimations().map(animation => ({state: animation.playState, target: animation.effect?.target?.nodeName || null}));
  let syntheticHidden = false;
  Object.defineProperty(document, 'hidden', {configurable: true, get: () => syntheticHidden});
  Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => syntheticHidden ? 'hidden' : 'visible'});
  function snapshot() {
    const activeListeners = [];
    for (const record of listeners.values()) {
      const target = record.target.deref();
      if (!target || !record.wrapper.deref()) { forget(record); continue; }
      const scope = target === window ? 'window' : target === document ? 'document' : target instanceof Node ? target.isConnected ? 'connected-dom' : 'detached-dom' : target instanceof AbortSignal ? 'abort-signal' : 'other-event-target';
      activeListeners.push({id: record.id, type: record.type, capture: record.capture, scope, label: record.label, target: target.nodeName || target.constructor?.name, stack: record.stack});
    }
    for (const [id, weak] of captures) { const node = weak.deref(); if (!node || !node.hasPointerCapture(id)) captures.delete(id); }
    const canvasEvidence = canvases.flatMap(record => { const node = record.canvas.deref(); return node ? [{kind: record.kind, connected: node.isConnected, width: node.width, height: node.height, draws: record.draws, label: record.label}] : []; });
    return {
      raf: [...frames].map(([id, value]) => ({id, ...value})),
      timeouts: [...timeouts].map(([id, value]) => ({id, ...value})),
      intervals: [...intervals].map(([id, value]) => ({id, ...value})), frameCallbacks, timerCallbacks, callbackSequence,
      listeners: activeListeners,
      observers: observers.filter(record => record.targets > 0).map(record => ({label: record.label, targets: record.targets, wrapperCollected: !record.observer.deref()})),
      workers: workers.filter(record => !record.terminated).map(record => ({url: record.url, wrapperCollected: !record.worker.deref()})),
      blobURLs: [...urls], captures: [...captures.keys()], canvases: canvasEvidence,
      gpu: glRecords.map(record => { const gl = record.context.deref(); return {kind: record.kind, label: record.label, collected: !gl, contextLost: gl?.isContextLost() ?? null, handles: {...record.counts}}; }),
      cssAnimations: animations(), domChildren: document.querySelector('#life-root')?.childElementCount ?? null,
      images: [...document.images].map(image => ({src: image.currentSrc || image.src, complete: image.complete, width: image.naturalWidth, height: image.naturalHeight})),
      audioSubscribers: window.mobileLifecycle?.audioSubscriberCount() ?? 0,
    };
  }
  window.__mobileLife = {
    snapshot, inputs,
    callbacksSince: sequence => callbacks.filter(record => record.sequence > sequence),
    settle: ms => new Promise(resolve => native.timeout(resolve, ms)),
    nextPaint: () => new Promise(resolve => native.raf(() => native.raf(resolve))),
    visibility(hidden) { syntheticHidden = hidden; document.dispatchEvent(new Event('visibilitychange')); },
  };
}
