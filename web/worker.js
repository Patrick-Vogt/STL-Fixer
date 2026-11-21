/* Runs the repair off the main thread so the page stays responsive. */
importScripts('stl-fixer-core.js');

self.onmessage = (e) => {
  const { id, buffer } = e.data;
  const post = (msg, transfer) => self.postMessage(Object.assign({ id }, msg), transfer || []);
  try {
    const r = self.StlFixer.fixMesh(buffer, {
      start: (label) => post({ type: 'start', label }),
      done: (label, text, level, ms) => post({ type: 'done', label, text, level, ms }),
      detail: (text) => post({ type: 'detail', text }),
    });
    post({
      type: 'result',
      before: r.before, after: r.after, nBefore: r.nBefore, nAfter: r.nAfter,
      facesIn: r.facesIn, facesOut: r.facesOut, buffer: r.buffer,
    }, [r.buffer]);
  } catch (err) {
    post({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
