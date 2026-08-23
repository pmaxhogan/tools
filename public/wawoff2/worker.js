/*
 * Dedicated worker for one wawoff2 codec direction. The emscripten glue in
 * *_binding.js is a classic script that publishes itself on the global
 * `Module` and never sets `module.exports` in the browser, so it must run in
 * a scope of its own: each direction gets its own Worker (the two bindings
 * also collide on globals like `calledRun`). Spawned by src/lib/woff2.ts as
 * new Worker("/wawoff2/worker.js?codec=compress" | "?codec=decompress").
 *
 * Protocol: { id, bytes } in, { id, ok, bytes } | { id, ok: false, error } out.
 */
var params = new URLSearchParams(self.location.search);
var codec = params.get("codec") === "compress" ? "compress" : "decompress";

var readyResolve;
var ready = new Promise(function (resolve) {
  readyResolve = resolve;
});
self.Module = {
  onRuntimeInitialized: function () {
    readyResolve();
  },
};
importScripts("/wawoff2/" + codec + "_binding.js");

self.onmessage = function (event) {
  var id = event.data.id;
  var bytes = event.data.bytes;
  ready
    .then(function () {
      var result = self.Module[codec](bytes);
      if (result === false) throw new Error("The WOFF2 " + codec + " call failed");
      var out = result instanceof Uint8Array ? result : new Uint8Array(result);
      self.postMessage({ id: id, ok: true, bytes: out }, [out.buffer]);
    })
    .catch(function (error) {
      self.postMessage({ id: id, ok: false, error: String(error && error.message) });
    });
};
