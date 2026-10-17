// Run with: node --test tests/sync.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

const html = readFileSync(new URL('../index.html', 'file://' + __filename), 'utf8');
const source = html.split('<script>')[1].split('// ─── INIT')[0];
const clone = value => JSON.parse(JSON.stringify(value));
const entry = (id, seconds = 120) => ({ id, projectId: 'p1', task: id, date: '2026-10-17', seconds, rate: 10, currency: 'USD', billed: false, manual: true });
const data = entries => ({ projects: [{ id: 'p1', name: 'Proyecto', client: 'Cliente', rate: 10, currency: 'USD' }], entries, timer: null, invCounter: 1 });

function drive() {
  const accounts = new Map();
  const calls = [];
  let failure = null;
  let hook = null;
  const account = id => {
    if (!accounts.has(id)) accounts.set(id, []);
    return accounts.get(id);
  };
  const response = (value, status = 200) => ({ ok: status < 400, status, json: async () => clone(value), headers: { get: () => null } });
  return {
    account, calls,
    failNext(status) { failure = status; },
    beforeNextRead(callback) { hook = callback; },
    async fetch(url, options = {}) {
      const owner = options.headers.Authorization.replace('Bearer ', '');
      const files = account(owner);
      const parsed = new URL(url);
      calls.push({ url, owner, method: options.method || 'GET' });
      if (failure) { const status = failure; failure = null; return response({}, status); }
      if (parsed.pathname.endsWith('/about')) return response({ user: { permissionId: owner, emailAddress: owner + '@example.com' } });
      if (parsed.searchParams.get('alt') === 'media') {
        const file = files.find(file => file.id === parsed.pathname.split('/').pop());
        if (!file) return response({}, 404);
        const content = clone(file.content);
        if (hook) { const callback = hook; hook = null; callback(); }
        return response(content);
      }
      if (options.method === 'PATCH') {
        const file = files.find(file => file.id === parsed.pathname.split('/').pop());
        if (!file) return response({}, 404);
        file.content = JSON.parse(options.body);
        return response({ id: file.id });
      }
      if (options.method === 'POST' && parsed.pathname.includes('/upload/')) {
        const content = JSON.parse(await options.body.get('file').text());
        const metadata = JSON.parse(await options.body.get('metadata').text());
        const file = { id: randomUUID(), name: metadata.name, content };
        files.push(file);
        return response({ id: file.id });
      }
      if (options.method === 'POST') return response({ id: 'folder' });
      const query = parsed.searchParams.get('q') || '';
      const name = query.match(/name = '([^']+)'/)?.[1];
      return response({ files: name === 'TimeTrack' ? [{ id: 'folder' }] : files.filter(file => (file.name || 'timetrack-data.json') === name).map(file => ({ id: file.id, name })) });
    }
  };
}

function browser(server, initial) {
  const local = new Map(initial ? [['tt_state', JSON.stringify(initial)]] : []);
  const elements = new Map();
  const intervals = new Map(), timeouts = new Map();
  let clockId = 0;
  const listeners = {};
  let oauth;
  const element = id => {
    if (!elements.has(id)) elements.set(id, { textContent: '', value: '', style: {}, className: '', disabled: false, hidden: false });
    return elements.get(id);
  };
  const context = vm.createContext({
    console: { error() {} }, crypto: { randomUUID }, URL, URLSearchParams, Blob, FormData, AbortSignal,
    localStorage: { getItem: key => local.get(key) || null, setItem: (key, value) => local.set(key, String(value)) },
    navigator: { onLine: true }, location: { protocol: 'https:' },
    document: { getElementById: element, visibilityState: 'visible', addEventListener: (name, callback) => { listeners[name] = callback; } },
    setInterval: callback => { intervals.set(++clockId, callback); return clockId; },
    clearInterval: id => intervals.delete(id),
    setTimeout: callback => { timeouts.set(++clockId, callback); return clockId; },
    clearTimeout: id => timeouts.delete(id),
    addEventListener: (name, callback) => { listeners[name] = callback; },
    fetch: server.fetch.bind(server),
    google: { accounts: { oauth2: { initTokenClient: options => { oauth = options; return { requestAccessToken() {} }; } } } }
  });
  context.window = context;
  vm.runInContext(source, context);
  vm.runInContext('let renderCount = 0; renderAll = () => { renderCount++; };', context);
  const run = code => vm.runInContext(code, context);
  return {
    run, local, element, intervals, listeners,
    state: () => clone(run('state')),
    async connect(owner = 'alice') { run('driveConnect(true)'); await oauth.callback({ access_token: owner, expires_in: 3600 }); },
    sync: () => run('driveSync()'),
    edit(code) { run(code); run('save()'); }
  };
}

test('a new computer downloads the existing file without creating or overwriting it', async () => {
  const server = drive();
  server.account('alice').push({ id: 'original', content: data([entry('e1')]) });
  const second = browser(server);
  await second.connect();
  assert.equal(second.state().entries[0].seconds, 120);
  assert.equal(server.account('alice').length, 1);
  assert.ok(!server.calls.some(call => call.method === 'POST'));
  assert.equal(second.element('drive-label').textContent, 'Sincronizado con Drive');
});

test('first connection uploads existing local history and a second computer recovers it', async () => {
  const server = drive();
  const first = browser(server, data([entry('local')]));
  await first.connect();
  const second = browser(server);
  await second.connect();
  assert.equal(second.state().entries[0].id, 'local');
  assert.equal(server.account('alice').length, 1);
});

test('legacy local records and duplicate Drive files are merged without losing unique entries', async () => {
  const server = drive();
  server.account('alice').push({ id: 'one', content: data([entry('cloud1')]) }, { id: 'two', content: data([entry('cloud2')]) });
  const app = browser(server, data([entry('local')]));
  await app.connect();
  assert.deepEqual(app.state().entries.map(e => e.id).sort(), ['cloud1', 'cloud2', 'local']);
  assert.equal(server.account('alice')[0].content.entries.length, 3);
});

test('offline edits and new records merge on reconnect; deletions do not reappear', async () => {
  const server = drive();
  server.account('alice').push({ id: 'one', content: data([entry('e1'), entry('e2')]) });
  const first = browser(server), second = browser(server);
  await first.connect();
  await second.connect();
  first.edit("state.entries.find(e => e.id === 'e1').seconds = 900; state.entries = state.entries.filter(e => e.id !== 'e2');");
  second.edit("state.entries.push({ ...state.entries[0], id: 'new', seconds: 60 });");
  await first.sync();
  await second.sync();
  await first.sync();
  assert.deepEqual(first.state(), second.state());
  assert.equal(first.state().entries.find(e => e.id === 'e1').seconds, 900);
  assert.ok(!first.state().entries.some(e => e.id === 'e2'));
  assert.ok(first.state().entries.some(e => e.id === 'new'));
});

test('active timer continues on another computer and stopping propagates back', async () => {
  const server = drive();
  const initial = data([entry('running', 0)]);
  initial.entries[0]._baseSec = 0;
  initial.timer = { entryId: 'running', startTs: Date.now() - 120000 };
  const first = browser(server, initial), second = browser(server);
  await first.connect();
  await second.connect();
  assert.ok(second.run('getTimerSeconds()') >= 120);
  assert.equal(second.element('start-btn').textContent, 'Detener');
  second.run('toggleTimer()');
  await second.sync();
  await first.sync();
  assert.equal(first.state().timer, null);
  assert.ok(first.state().entries[0].seconds >= 120);
  assert.equal(first.element('start-btn').textContent, 'Iniciar');
  assert.equal(first.intervals.size, 1); // Only the sync interval remains.
});

test('edits made during a download survive the merge', async () => {
  const server = drive();
  server.account('alice').push({ id: 'one', content: data([entry('e1')]) });
  const app = browser(server);
  await app.connect();
  server.beforeNextRead(() => app.edit('state.entries[0].seconds = 3600;'));
  await app.sync();
  assert.equal(app.state().entries[0].seconds, 3600);
  assert.equal(server.account('alice')[0].content.entries[0].seconds, 3600);
});

test('account switching isolates cached histories and does not upload the old account', async () => {
  const server = drive();
  server.account('alice').push({ id: 'a', content: data([entry('alice-entry')]) });
  server.account('bob').push({ id: 'b', content: data([entry('bob-entry')]) });
  const app = browser(server);
  await app.connect('alice');
  app.edit('state.entries[0].seconds = 500;');
  await app.connect('bob');
  assert.deepEqual(app.state().entries.map(e => e.id), ['bob-entry']);
  assert.deepEqual(server.account('bob')[0].content.entries.map(e => e.id), ['bob-entry']);
  await app.connect('alice');
  assert.equal(app.state().entries[0].seconds, 500);
});

test('HTTP failure retains local changes, reports an error, and can retry', async () => {
  const server = drive();
  const app = browser(server, data([entry('e1')]));
  await app.connect();
  app.edit('state.entries[0].seconds = 600;');
  server.failNext(403);
  await app.sync();
  assert.match(app.element('drive-label').textContent, /403/);
  assert.equal(JSON.parse(app.local.get('tt_state')).entries[0].seconds, 600);
  await app.sync();
  assert.equal(server.account('alice')[0].content.entries[0].seconds, 600);
  assert.equal(app.element('drive-label').textContent, 'Sincronizado con Drive');
});

test('401 expires the session and leaves reconnect available', async () => {
  const server = drive();
  const app = browser(server);
  await app.connect();
  server.failNext(401);
  await app.sync();
  assert.equal(app.run('driveToken'), null);
  assert.equal(app.element('drive-btn').disabled, false);
  assert.equal(app.element('drive-label').textContent, 'Vuelve a conectar Drive');
  await app.connect();
  assert.equal(app.element('drive-label').textContent, 'Sincronizado con Drive');
});

test('invalid cloud data cannot overwrite local data', async () => {
  const server = drive();
  server.account('alice').push({ id: 'broken', content: { entries: 'bad' } });
  const app = browser(server, data([entry('safe')]));
  await app.connect();
  assert.equal(app.state().entries[0].id, 'safe');
  assert.ok(!server.calls.some(call => call.method === 'PATCH' || call.method === 'POST'));
  assert.notEqual(app.element('drive-label').textContent, 'Sincronizado con Drive');
});

test('unchanged polling preserves invoice forms and does not restart the timer', async () => {
  const server = drive();
  const app = browser(server, data([entry('e1')]));
  await app.connect();
  app.element('inv-num').value = 'MI-FACTURA';
  const before = app.run('renderCount');
  await app.sync();
  await app.sync();
  assert.equal(app.run('renderCount'), before);
  assert.equal(app.element('inv-num').value, 'MI-FACTURA');
  assert.equal(app.run('saveTimeout'), null);
});


test('first sync keeps a downloadable original local copy and a separate original cloud backup', async () => {
  const server = drive();
  const cloud = data([entry('cloud')]);
  server.account('alice').push({ id: 'original', content: cloud });
  const local = data([entry('local')]);
  const app = browser(server, local);
  await app.connect();
  const backup = JSON.parse(app.local.get('tt_before_sync_v1_alice'));
  assert.deepEqual(backup.entries, local.entries);
  assert.equal(app.element('backup-btn').hidden, false);
  const remoteBackup = server.account('alice').find(file => file.name === 'timetrack-respaldo-original.json');
  assert.deepEqual(remoteBackup.content, cloud);
  app.edit('state.entries[0].seconds = 999;');
  await app.sync();
  assert.equal(app.local.get('tt_before_sync_v1_alice'), JSON.stringify(backup));
  assert.equal(server.account('alice').filter(file => file.name === 'timetrack-respaldo-original.json').length, 1);
});

test('invoice snapshots synchronize, survive edits to source entries, and propagate cancellation', async () => {
  const server = drive();
  const first = browser(server, data([entry('e1')]));
  await first.connect();
  first.edit(`
    state.invoices.push({id:'i1',num:'INV-001',date:'2026-10-17',due:'',taxPct:18,from:'Lipe',fromD:'',to:'Cliente',toD:'',notes:'',currency:'USD',status:'issued',items:JSON.parse(JSON.stringify(state.entries))});
    state.entries[0].billed=true;state.entries[0].invoiceId='i1';state.invCounter=2;
  `);
  await first.sync();
  const second=browser(server);
  await second.connect();
  assert.equal(second.state().invoices[0].items[0].seconds,120);
  assert.equal(second.state().invCounter,2);
  first.edit(`state.entries[0].seconds=600;`);
  await first.sync();await second.sync();
  assert.equal(second.state().invoices[0].items[0].seconds,120);
  assert.equal(second.state().entries[0].seconds,600);
  second.edit(`state.invoices[0].status='void';state.entries[0].billed=false;delete state.entries[0].invoiceId;`);
  await second.sync();await first.sync();
  assert.equal(first.state().invoices[0].status,'void');
  assert.equal(first.state().entries[0].billed,false);
});

test('malformed backup identifiers, money, dates and invoices are rejected before replacing data', () => {
  const app=browser(drive());
  for(const mutation of [
    "value.entries[0].id=\"e' onclick='bad\"",
    'value.entries[0].rate=-1',
    "value.entries[0].date='2026-02-30'",
    "value.projects[0].currency='<script>'",
    "value.invoices='bad'",
    "value.invCounter=Infinity"
  ]) {
    const input=JSON.stringify(data([entry('e1')]));
    assert.equal(app.run(`(() => {const value=${input};${mutation};try{normalizeState(value);return false;}catch{return true;}})()`),true);
  }
});
