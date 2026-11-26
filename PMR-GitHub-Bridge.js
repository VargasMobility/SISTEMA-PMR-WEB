/* PMR GitHub Pages <-> Apps Script HTML service — bridge V1.
 * No hace llamadas fetch cross-origin a ContentService.
 * No transmite nombres de pasajeros ni claves a postMessage de orígenes ajenos.
 * Intercepta EXCLUSIVAMENTE las seis acciones autenticadas portalAerolinea*.
 * Los demás fetch se mantienen sin modificaciones.
 */
(function () {
  'use strict';
  if (window.PMRGithubBridge) return;

  var actions = Object.freeze({
    portalAerolineaValidarAcceso: 1,
    portalAerolineaListAll: 1,
    portalAerolineaEnqueueGuardarTodo: 1,
    portalAerolineaEnqueueEliminarVuelo: 1,
    portalAerolineaQueueStatus: 1,
    portalAerolineaRequestStatus: 1
  });
  var nativeFetch = window.fetch.bind(window);
  var bridge = null;
  var counter = 0;

  function allowedGoogleOrigin(origin) {
    try {
      var u = new URL(origin);
      if (u.protocol !== 'https:') return false;
      var h = u.hostname.toLowerCase();
      return h === 'script.google.com' || h === 'script.googleusercontent.com' ||
        h.endsWith('-script.googleusercontent.com') || h.endsWith('.script.googleusercontent.com');
    } catch (_) { return false; }
  }
  function isWebAppUrl(raw) {
    try {
      var u = new URL(raw, window.location.href);
      return u.protocol === 'https:' && u.hostname === 'script.google.com' &&
        /^\/(?:a\/macros\/[^/]+\/s|macros\/s)\/[^/]+\/exec$/.test(u.pathname);
    } catch (_) { return false; }
  }
  function randomNonce() {
    var a = new Uint8Array(24);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(a);
    else for (var i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
    return Array.from(a, function (n) { return n.toString(16).padStart(2, '0'); }).join('');
  }
  function transportError(reason) {
    return new TypeError('No se pudo conectar al canal GitHub de Web PMR: ' + reason +
      ' Comprueba que GitHub.gs está publicado en /exec y que el navegador permite cargar el iframe de Google.');
  }
  function ensureBridge(apiUrl) {
    if (bridge && bridge.url === apiUrl) return bridge;
    if (bridge && bridge.url !== apiUrl) throw transportError('La página intenta utilizar dos implementaciones distintas.');
    var b = {
      url: apiUrl, nonce: randomNonce(), ready: false, child: null,
      childOrigin: '', pending: Object.create(null), readyTimer: null,
      readyResolve: null, readyReject: null, frame: null
    };
    bridge = b;
    b.readyPromise = new Promise(function (resolve, reject) {b.readyResolve = resolve; b.readyReject = reject;});
    window.addEventListener('message', function (evt) {
      var msg = evt.data;
      if (!msg || msg.pmrGhBridge !== 1 || msg.nonce !== b.nonce) return;
      if (!allowedGoogleOrigin(evt.origin)) return;
      if (msg.type === 'READY') {
        if (b.ready) return;
        b.ready = true;
        b.child = evt.source;
        b.childOrigin = evt.origin;
        clearTimeout(b.readyTimer);
        b.readyResolve();
        return;
      }
      if (evt.source !== b.child || evt.origin !== b.childOrigin) return;
      if (msg.type === 'ERROR' && !b.ready) {
        clearTimeout(b.readyTimer);
        b.readyReject(transportError(String(msg.error || 'Error al iniciar el puente.')));
      } else if (msg.type === 'RESULT') {
        var item = b.pending[String(msg.id || '')];
        if (!item) return;
        delete b.pending[String(msg.id)];
        clearTimeout(item.timer);
        if (msg.error) item.reject(new Error(String(msg.error)));
        else item.resolve(msg.result || {ok:false,error:'Respuesta vacía del servidor.'});
      }
    });
    b.readyTimer = setTimeout(function () {
      b.readyReject(transportError('El iframe de Google no confirmó su inicialización en 20 segundos.'));
    }, 20000);
    var src = new URL(apiUrl);
    src.searchParams.set('v', 'github_bridge');
    src.searchParams.set('nonce', b.nonce);
    src.searchParams.set('cb', String(Date.now()));
    var frame = document.createElement('iframe');
    frame.src = src.href;
    frame.title = 'Comunicación segura Web PMR';
    frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;border:0;opacity:0;pointer-events:none;';
    b.frame = frame;
    (document.body || document.documentElement).appendChild(frame);
    return b;
  }

  function abortErr() {
    var err = new Error('La solicitud excedió el tiempo de espera; la escritura podría seguir en proceso.');
    err.name = 'AbortError';
    return err;
  }
  async function call(apiUrl, action, params, opts) {
    if (!actions[action]) throw new Error('Acción GitHub no autorizada: ' + action);
    opts = opts || {};
    var b = ensureBridge(apiUrl);
    var signal = opts.signal;
    if (signal && signal.aborted) throw abortErr();
    await b.readyPromise;
    if (signal && signal.aborted) throw abortErr();
    if (Object.keys(b.pending).length >= 12) throw transportError('Hay demasiadas solicitudes simultáneas.');
    var id = 'gh' + (++counter).toString(36) + '_' + randomNonce().slice(0, 12);
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer;
      function done(err, result) {
        if (settled) return;
        settled = true;
        delete b.pending[id];
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        if (err) reject(err);
        else resolve(result);
      }
      function onAbort() {done(abortErr());}
      var ms = Math.min(Math.max(Number(opts.timeoutMs) || 120000, 1000), 180000);
      timer = setTimeout(function () {done(transportError('Tiempo máximo de respuesta agotado.'));}, ms);
      b.pending[id] = {resolve:function(r){done(null,r);},reject:function(e){done(e);},timer:timer};
      if (signal) signal.addEventListener('abort', onAbort, {once:true});
      try {
        b.child.postMessage({pmrGhBridge:1, type:'CALL', nonce:b.nonce, id:id,
          action:action, params:params || {}}, b.childOrigin);
      } catch (err) {done(transportError(String(err && err.message || err)));}
    });
  }

  window.PMRGithubBridge = Object.freeze({call:call, actions:actions, version:'1.0'});

  window.fetch = function (input, init) {
    init = init || {};
    var url = typeof input === 'string' ? input : ((input && input.url) || '');
    if (!isWebAppUrl(url)) return nativeFetch(input, init);
    var u = new URL(url, window.location.href);
    var method = String(init.method || ((input && input.method) || 'GET')).toUpperCase();
    var p = {};
    u.searchParams.forEach(function (v, k) {p[k] = v;});
    if (method !== 'GET') {
      if (typeof init.body !== 'string') return nativeFetch(input, init);
      try {
        var parsed = JSON.parse(init.body);
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return nativeFetch(input, init);
        Object.assign(p, parsed);
      } catch (_) {return nativeFetch(input, init);}
    }
    var action = String(p.action || '').trim();
    if (!actions[action]) return nativeFetch(input, init);
    return call(u.origin + u.pathname, action, p, {signal:init.signal, timeoutMs:150000})
      .then(function (result) {
        return {
          ok:true, status:200,
          text:function(){return Promise.resolve(JSON.stringify(result));},
          json:function(){return Promise.resolve(result);}
        };
      });
  };
})();
