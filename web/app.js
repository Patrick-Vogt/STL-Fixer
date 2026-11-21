'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const drop = $('drop'), input = $('file'), list = $('list'), bar = $('bar');
  const barText = $('barText'), zipBtn = $('zipBtn'), clearBtn = $('clearBtn'), notice = $('notice');

  const items = [];
  let worker = null;
  let busy = false;
  let seq = 0;

  const fmtN = (n) => n.toLocaleString('en-US');
  const fmtSize = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
  const fmtMs = (ms) => (ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(1) + ' s');
  const MARK = { ok: '✓', warn: '!', fail: '✗', run: '…' };

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function showNotice(text) {
    notice.textContent = text;
    notice.hidden = !text;
  }

  // ----------------------------------------------------------- worker --
  function getWorker() {
    if (worker) return worker;
    try {
      worker = new Worker('worker.js');
    } catch (err) {
      showNotice('Could not start the repair worker. Open this page through a web server (or the GitHub Pages link), not as a local file.');
      throw err;
    }
    worker.onerror = (e) => {
      showNotice('The repair worker failed to load. If you opened this page as a local file, serve it over http instead (for example: python3 -m http.server).');
      const it = items.find((i) => i.status === 'run');
      if (it) fail(it, e.message || 'worker error');
    };
    worker.onmessage = onWorkerMessage;
    return worker;
  }

  function onWorkerMessage(e) {
    const m = e.data;
    const it = items.find((i) => i.id === m.id);
    if (!it) return;
    if (m.type === 'start') {
      it.pending = addLine(it, 'run', m.label, '');
    } else if (m.type === 'done') {
      const li = it.pending || addLine(it, m.level, m.label, m.text);
      it.pending = null;
      li.className = m.level;
      li.querySelector('.m').textContent = MARK[m.level] || '•';
      li.querySelector('.t').textContent = m.text;
      li.querySelector('.ms').textContent = fmtMs(m.ms);
    } else if (m.type === 'detail') {
      const li = el('li', 'detail', m.text);
      it.log.appendChild(li);
    } else if (m.type === 'result') {
      it.result = m;
      it.blob = new Blob([m.buffer], { type: 'model/stl' });
      it.status = m.nAfter ? 'warn' : 'ok';
      finish(it);
    } else if (m.type === 'error') {
      fail(it, m.message);
    }
    scroll(it);
  }

  function scroll(it) { it.log.scrollTop = it.log.scrollHeight; }

  function addLine(it, level, label, text) {
    const li = el('li', level);
    li.append(el('span', 'm', MARK[level] || '•'), el('span', 'l', label), el('span', 't', text), el('span', 'ms', ''));
    it.log.appendChild(li);
    return li;
  }

  // ------------------------------------------------------------ queue --
  function addFiles(files) {
    const stls = [...files].filter((f) => /\.stl$/i.test(f.name));
    const skipped = files.length - stls.length;
    showNotice(skipped ? `${skipped} file(s) skipped, only .stl files are supported.` : '');
    for (const file of stls) {
      const it = { id: ++seq, file, status: 'wait', result: null, blob: null };
      buildCard(it);
      items.push(it);
    }
    refreshBar();
    next();
  }

  function buildCard(it) {
    const card = el('article', 'card');
    const head = el('header');
    const left = el('div');
    left.append(el('h2', '', it.file.name), el('div', 'meta', fmtSize(it.file.size)));
    it.chip = el('span', 'chip', 'Waiting');
    head.append(left, it.chip);
    it.log = el('ul', 'log');
    it.foot = el('div', 'foot');
    it.foot.hidden = true;
    card.append(head, it.log, it.foot);
    it.card = card;
    list.appendChild(card);
  }

  async function next() {
    if (busy) return;
    const it = items.find((i) => i.status === 'wait');
    if (!it) return;
    busy = true;
    it.status = 'run';
    setChip(it, 'run', 'Working');
    refreshBar();
    try {
      const buffer = await it.file.arrayBuffer();
      getWorker().postMessage({ id: it.id, buffer }, [buffer]);
    } catch (err) {
      fail(it, err.message || String(err));
    }
  }

  function setChip(it, cls, text) {
    it.chip.className = 'chip ' + cls;
    it.chip.textContent = text;
  }

  function finish(it) {
    const r = it.result;
    if (!r.nAfter) {
      setChip(it, 'ok', r.nBefore ? 'Fixed' : 'Clean');
    } else {
      setChip(it, 'warn', 'Issues remain');
    }
    const verdict = el('span', 'verdict');
    if (!r.nBefore) {
      verdict.append(b('ok', 'No issues found.'), ' Saved as a clean copy.');
    } else if (!r.nAfter) {
      verdict.append(b('ok', `Fixed ${fmtN(r.nBefore)} finding${r.nBefore === 1 ? '' : 's'}.`));
    } else {
      verdict.append(b('warn', `${fmtN(r.nAfter)} issue(s) remain`), ` (of ${fmtN(r.nBefore)} found).`);
    }
    const dl = el('button', 'btn', 'Download fixed_' + it.file.name);
    dl.onclick = () => save(it.blob, 'fixed_' + it.file.name);
    it.foot.append(verdict, dl);
    it.foot.hidden = false;
    done(it);
  }

  const b = (cls, text) => { const e = el('b', cls, text); return e; };

  function fail(it, message) {
    it.status = 'fail';
    setChip(it, 'fail', 'Failed');
    addLine(it, 'fail', 'Error', message);
    done(it);
  }

  function done(it) {
    busy = false;
    refreshBar();
    next();
  }

  function refreshBar() {
    bar.hidden = items.length === 0;
    const finished = items.filter((i) => i.blob);
    const fixed = items.reduce((s, i) => s + (i.result ? i.result.nBefore : 0), 0);
    const left = items.reduce((s, i) => s + (i.result ? i.result.nAfter : 0), 0);
    const open = items.filter((i) => i.status === 'wait' || i.status === 'run').length;
    const parts = [];
    parts.push(`<b>${finished.length}</b> of ${items.length} file${items.length === 1 ? '' : 's'} done`);
    if (finished.length) parts.push(`<b>${fmtN(fixed)}</b> finding${fixed === 1 ? '' : 's'} found, <b>${fmtN(fixed - left)}</b> fixed`);
    barText.innerHTML = parts.join(' · ');
    zipBtn.hidden = !(finished.length > 1 && open === 0);
  }

  // ------------------------------------------------------------ files --
  function save(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return (u8) => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = t[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  })();

  /** Minimal "stored" zip writer. */
  async function makeZip(entries) {
    const enc = new TextEncoder();
    const chunks = [], central = [];
    let offset = 0;
    const used = new Set();
    for (const { name, blob } of entries) {
      let n = name, i = 1;
      while (used.has(n)) n = name.replace(/(\.stl)?$/i, `_${i++}$1`);
      used.add(n);
      const data = new Uint8Array(await blob.arrayBuffer());
      const nameBytes = enc.encode(n);
      const crc = CRC(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint16(8, 0, true); lh.setUint16(10, 0, true); lh.setUint16(12, 0x21, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
      lh.setUint16(26, nameBytes.length, true); lh.setUint16(28, 0, true);
      chunks.push(new Uint8Array(lh.buffer), nameBytes, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true); ch.setUint16(12, 0, true); ch.setUint16(14, 0x21, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
      ch.setUint16(28, nameBytes.length, true); ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), nameBytes);
      offset += 30 + nameBytes.length + data.length;
    }
    const cdSize = central.reduce((s, c) => s + c.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
  }

  // ----------------------------------------------------------- events --
  input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
  // dropping next to the zone should not make the browser open the file
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => { if (!drop.contains(e.target)) { e.preventDefault(); addFiles(e.dataTransfer.files); } });

  zipBtn.addEventListener('click', async () => {
    const entries = items.filter((i) => i.blob).map((i) => ({ name: 'fixed_' + i.file.name, blob: i.blob }));
    save(await makeZip(entries), 'fixed_stl_files.zip');
  });

  clearBtn.addEventListener('click', () => {
    if (busy && worker) { worker.terminate(); worker = null; busy = false; }
    items.length = 0;
    list.textContent = '';
    showNotice('');
    refreshBar();
  });
})();
