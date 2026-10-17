// Chrome is run with an isolated temporary profile. No personal browser data is used.
// Run: node --test tests/browser.test.cjs (requires Google Chrome on macOS).
const {test} = require('node:test');
const {readFileSync, mkdtempSync, readdirSync, rmSync} = require('node:fs');
const {join} = require('node:path');
const {tmpdir} = require('node:os');
const {launch,assert,sleep} = require('./browser-helper.cjs');

test('full tracker, invoices, backups, printing and mobile workflow in Chrome', {timeout:120000}, async t => {
  const browser=await launch(process.cwd());
  const {evaluate:run,reload,call}=browser;
  const downloads=mkdtempSync(join(tmpdir(),'timetrack-downloads-'));
  await browser.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
  try {
    await t.test('local calendar dates after 19:00 in Lima and Monday week boundary', async()=>{
      await call('Emulation.setTimezoneOverride',{timezoneId:'America/Lima'});
      assert.equal(await run("localDate(new Date('2026-10-18T02:30:00Z'))"),'2026-10-17');
      const stats=await run(`(() => {
        const OriginalDate = Date;
        Date = class extends OriginalDate { constructor(...args) { super(...(args.length ? args : ['2026-10-19T10:00:00-05:00'])); } static now() { return new OriginalDate('2026-10-19T10:00:00-05:00').getTime(); } };
        state.entries = ['2026-10-18','2026-10-19','2026-10-20'].map((date,i)=>({id:'e'+i,task:'Test',date,seconds:3600,rate:10,currency:'USD',billed:false}));
        updateStats(); const text=document.getElementById('stat-semana').textContent;
        Date=OriginalDate;state=normalizeState(emptyState());previousState=structuredClone(state);return text;
      })()`);
      assert.equal(stats,'1h 0m');
    });
    await t.test('project creation escapes text and handles reserved object keys as task names',async()=>{
      await run(`document.getElementById('new-proj-name').value='Diseño <img src=x onerror="window.injected=true">';document.getElementById('new-proj-client').value='Cliente "A"';document.getElementById('t-rate').value='50';createProject();`);
      assert.equal(await run('state.projects.length'),1);
      assert.equal(await run('document.querySelectorAll("#project-tree img").length'),0);
      assert.equal(await run('window.injected===true'),false);
      assert.equal(await run('document.getElementById("t-project").value'),await run('state.projects[0].id'));
    });
    await t.test('timer starts immediately, accepts an explicit zero rate, restores and stops',async()=>{
      await run(`document.getElementById('t-task').value='constructor';document.getElementById('t-rate').value='0';toggleTimer();state.timer.startTs-=65000;save();`);
      assert.equal(await run('state.entries[0].rate'),0);
      assert.equal(await run('document.querySelectorAll("#recent-list .task-row").length'),1);
      await reload();
      assert.equal(await run('document.getElementById("start-btn").textContent'),'Detener');
      assert.ok(await run('getTimerSeconds()>=65'));
      await run('openEditEntry(state.entries[0].id)');
      assert.match(await run('alerts.at(-1)'),/Detén/);
      await run('toggleTimer()');
      assert.equal(await run('state.timer'),null);
      assert.ok(await run('state.entries[0].seconds>=65'));
    });
    await t.test('manual input rejects negatives and invalid minutes; project supplies the rate',async()=>{
      await run(`nav('manual');document.getElementById('m-project').value=state.projects[0].id;syncTaskSelect('m-project');`);
      assert.equal(await run('document.getElementById("m-rate").value'),'50');
      const count=await run('state.entries.length');
      await run(`document.getElementById('m-task').value='Trabajo';document.getElementById('m-hours').value='-2';addManual();`);
      assert.equal(await run('state.entries.length'),count);
      await run(`document.getElementById('m-hours').value='1';document.getElementById('m-minutes').value='60';addManual();`);
      assert.equal(await run('state.entries.length'),count);
      await run(`document.getElementById('m-minutes').value='30';addManual();`);
      assert.equal(await run('state.entries[0].seconds'),5400);
    });
    await t.test('editing a description preserves seconds and safely displays quotes',async()=>{
      await run(`state.entries[0].seconds=3667;save();openEditEntry(state.entries[0].id);document.getElementById('edit-task').value='Diseño "final" <b>texto</b>';saveEditEntry(state.entries[0].id);`);
      assert.equal(await run('state.entries[0].seconds'),3667);
      assert.equal(await run('document.querySelectorAll("#all-entries-list b").length'),0);
      await run('openEditEntry(state.entries[0].id)');
      assert.equal(await run('document.getElementById("edit-task").value'),'Diseño "final" <b>texto</b>');
      await run('closeEditEntry()');
    });
    await t.test('mixed currencies have separate totals and cannot share a single invoice',async()=>{
      await run(`state.entries.push({...state.entries[0],id:'epen',currency:'PEN',seconds:3600,rate:20});save();nav('facturas');document.querySelectorAll('#inv-selector input').forEach(input=>input.checked=true);generateInvoice();`);
      assert.equal(await run('state.invoices.length'),0);
      assert.match(await run('alerts.at(-1)'),/moneda/);
      assert.match(await run('document.getElementById("stat-pending").textContent'),/USD .*PEN/);
      await run(`document.querySelectorAll('#inv-selector input').forEach(input=>input.checked=input.value!=='epen');document.getElementById('inv-to').value='Cliente A';document.getElementById('inv-from').value='Lipe';document.getElementById('inv-num').value="DOC-'001";generateInvoice();`);
      assert.equal(await run('state.invoices.length'),1);
      assert.equal(await run('document.getElementById("inv-num").value'),'INV-002');
    });
    await t.test('invoice survives reload, reopens, and protects billed entries',async()=>{
      await reload();await run(`nav('facturas');showInvoice(state.invoices[0].id);`);
      assert.equal(await run('document.querySelector(".inv-p-num").textContent'),"DOC-'001");
      assert.match(await run('document.getElementById("inv-content").textContent'),/Diseño "final" <b>texto<\/b>/);
      const count=await run('state.entries.length');
      await run('deleteEntry(state.invoices[0].items[0].id)');
      assert.equal(await run('state.entries.length'),count);
      assert.match(await run('alerts.at(-1)'),/Anula/);
    });
    await t.test('print media retains invoice and hides unrelated controls',async()=>{
      await call('Emulation.setEmulatedMedia',{media:'print'});
      assert.equal(await run('getComputedStyle(document.getElementById("page-facturas")).display'),'block');
      assert.notEqual(await run('getComputedStyle(document.getElementById("inv-content")).display'),'none');
      assert.equal(await run('getComputedStyle(document.querySelector(".invoice-actions")).display'),'none');
      const pdf=await call('Page.printToPDF',{printBackground:true});
      assert.ok(Buffer.from(pdf.data,'base64').length>5000);
      await call('Emulation.setEmulatedMedia',{media:''});
    });
    await t.test('real PDF libraries produce a downloadable document',async()=>{
      assert.equal(await run('typeof html2canvas'),'function');
      assert.equal(await run('typeof window.jspdf?.jsPDF'),'function');
      await run('downloadPDF()');
      for(let i=0;i<50&&!readdirSync(downloads).some(name=>name.endsWith('.pdf'));i++)await sleep(100);
      const file=readdirSync(downloads).find(name=>name.endsWith('.pdf'));
      assert.ok(file,'PDF was not downloaded');
      assert.equal(readFileSync(join(downloads,file)).subarray(0,5).toString(),'%PDF-');
      assert.equal(await run('document.getElementById("pdf-btn").disabled'),false);
    });
    await t.test('annulling an invoice restores its entries without deleting its history',async()=>{
      await run('voidInvoice(state.invoices[0].id)');
      assert.equal(await run('state.invoices[0].status'),'void');
      assert.ok(await run('state.entries.every(entry=>!entry.billed)'));
      assert.match(await run('document.querySelector(".inv-p-title").textContent'),/Anulada/);
    });
    await t.test('JSON export and import round-trip with invoices intact',async()=>{
      await run('exportData()');
      for(let i=0;i<30&&!readdirSync(downloads).some(name=>name.endsWith('.json'));i++)await sleep(100);
      const file=readdirSync(downloads).find(name=>name.endsWith('.json'));
      assert.ok(file,'JSON was not downloaded');
      const backup=JSON.parse(readFileSync(join(downloads,file),'utf8'));
      assert.equal(backup.invoices.length,1);
      await run(`window.backupText=${JSON.stringify(JSON.stringify(backup))};importData({target:{files:[new File([backupText],'backup.json',{type:'application/json'})],value:''}});`);
      for(let i=0;i<30&&!(await run('alerts.some(message=>message.includes("Datos importados"))'));i++)await sleep(50);
      assert.equal(await run('state.invoices.length'),1);
    });
    await t.test('mobile exposes Drive and backup controls without horizontal page overflow',async()=>{
      await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
      await run(`nav('tracker')`);
      assert.notEqual(await run('getComputedStyle(document.querySelector(".sidebar-footer")).display'),'none');
      assert.ok(await run('document.getElementById("drive-btn").getBoundingClientRect().width>100'));
      assert.ok(await run('document.documentElement.scrollWidth<=window.innerWidth'), 'Mobile page overflows');
    });
    await t.test('deleting active entries stops the timer and deletion can be cancelled',async()=>{
      await run(`document.getElementById('t-task').value='Temporal';toggleTimer();window.confirm=()=>false;deleteEntry(state.timer.entryId);`);
      assert.notEqual(await run('state.timer'),null);
      await run(`window.confirm=()=>true;deleteEntry(state.timer.entryId);`);
      assert.equal(await run('state.timer'),null);
      assert.equal(await run('document.getElementById("start-btn").textContent'),'Iniciar');
    });
    await t.test('two tabs combine pending records and stop a shared timer',async()=>{
      const tab=await browser.newPage();
      try {
        const second=tab.evaluate;
        await run(`document.getElementById('t-task').value='Entre pestañas';toggleTimer();`);
        for(let i=0;i<40&&!(await second('state.timer'));i++)await sleep(25);
        assert.ok(await second('state.timer'));
        await second('toggleTimer()');
        for(let i=0;i<40&&(await run('state.timer'));i++)await sleep(25);
        assert.equal(await run('state.timer'),null);
        assert.equal(await run('document.getElementById("start-btn").textContent'),'Iniciar');
        await run(`state.entries.push({...state.entries[0],id:'etabA',task:'Desde A'});save();`);
        await second(`state.entries.push({...state.entries[0],id:'etabB',task:'Desde B'});save();`);
        for(let i=0;i<40&&!(await run('state.entries.some(e=>e.id==="etabB")'));i++)await sleep(25);
        assert.ok(await run('state.entries.some(e=>e.id==="etabA") && state.entries.some(e=>e.id==="etabB")'));
        assert.ok(await second('state.entries.some(e=>e.id==="etabA") && state.entries.some(e=>e.id==="etabB")'));
      } finally {await tab.close();}
    });
    await t.test('invoice totals equal the sum of rounded lines and previews reflect remote cancellation',async()=>{
      await run(`state=normalizeState(emptyState());previousState=structuredClone(state);state.entries=Array.from({length:3},(_,i)=>({id:'ecents'+i,task:'Trabajo breve',date:today(),seconds:1,rate:18,currency:'USD',billed:false,manual:true,projectId:null}));save();nav('facturas');document.getElementById('inv-num').value='CENTAVOS';document.getElementById('inv-tax').value='18';document.querySelectorAll('#inv-selector input').forEach(input=>input.checked=true);generateInvoice();`);
      const totals=await run(`Array.from(document.querySelectorAll('.inv-p-trow')).map(row=>row.lastElementChild.textContent)`);
      assert.deepEqual(totals,['USD 0.03','USD 0.01','USD 0.04']);
      await run(`state.invoices[0].status='void';renderInvoiceHistory();`);
      assert.match(await run('document.querySelector(".inv-p-title").textContent'),/Anulada/);
    });
    await t.test('multi-page PDF exports the complete invoice',async()=>{
      await call('Emulation.clearDeviceMetricsOverride');
      await run(`state=normalizeState(emptyState());previousState=structuredClone(state);state.entries=Array.from({length:65},(_,i)=>({id:'elong'+i,task:'Trabajo detallado '+i,date:today(),seconds:3600,rate:20,currency:'USD',billed:false,manual:true,projectId:null}));save();nav('facturas');document.getElementById('inv-num').value='LARGA';document.querySelectorAll('#inv-selector input').forEach(input=>input.checked=true);generateInvoice();`);
      assert.equal(await run('state.invoices[0].items.length'),65);
      await run('downloadPDF()');
      for(let i=0;i<50&&!readdirSync(downloads).includes('factura-LARGA.pdf');i++)await sleep(100);
      const content=readFileSync(join(downloads,'factura-LARGA.pdf')).toString('latin1');
      assert.ok((content.match(/\/Type \/Page\b/g)||[]).length>=2,'Long invoice must have multiple pages');
    });
    await t.test('invalid imports leave the current records intact',async()=>{
      const count=await run('state.entries.length');
      await run(`importData({target:{files:[new File(['{"projects":[],"entries":[{"id":"bad"}]}'],'invalid.json')],value:''}});`);
      await sleep(100);
      assert.equal(await run('state.entries.length'),count);
      assert.match(await run('alerts.at(-1)'),/Error al leer/);
    });
    await t.test('unreadable local data stays recoverable and saving is blocked',async()=>{
      await run(`localStorage.setItem('tt_state','{invalid-json');`);
      await reload();
      assert.ok(await run('recoveryData'));
      assert.equal(await run('document.getElementById("app-notice").hidden'),false);
      assert.match(await run('document.getElementById("app-notice").textContent'),/recuperación/);
      const error=await run(`(() => {try{save();return '';}catch(error){return error.message;}})()`);
      assert.match(error,/recuperarse/);
      assert.equal(await run('localStorage.getItem("tt_state")'),'{invalid-json');
      await run(`recoveryData=null;state=normalizeState(emptyState());previousState=structuredClone(state);save();`);
    });
    await t.test('storage quota failures show a warning instead of reporting a successful save',async()=>{
      const error=await run(`(() => {const original=Storage.prototype.setItem;Storage.prototype.setItem=()=>{throw new DOMException('Full','QuotaExceededError');};let message;try{save();}catch(error){message=error.name;}finally{Storage.prototype.setItem=original;}return message;})()`);
      assert.equal(error,'QuotaExceededError');
      assert.equal(await run('localWriteFailed'),true);
      assert.equal(await run('document.getElementById("app-notice").hidden'),false);
      await run('save()');
      assert.equal(await run('localWriteFailed'),false);
    });
    assert.deepEqual(browser.errors,[],'Unexpected JavaScript errors');
  } finally {await browser.close();rmSync(downloads,{recursive:true,force:true});}
});
