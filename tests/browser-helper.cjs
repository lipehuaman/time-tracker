const { spawn } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function launch(root) {
  const server = createServer((req,res) => { res.setHeader('Content-Type','text/html; charset=utf-8'); res.end(readFileSync(join(root,'index.html'))); });
  await new Promise(r => server.listen(0,'127.0.0.1',r));
  const profile = mkdtempSync(join(tmpdir(),'timetrack-review-'));
  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank']);
  const endpoint = await new Promise((resolve,reject) => {
    let log=''; const timer=setTimeout(()=>reject(new Error('Chrome timeout: '+log)),15000);
    chrome.stderr.on('data', chunk => { log+=chunk; const match=log.match(/DevTools listening on (ws:\/\/[^\s]+)/); if(match){clearTimeout(timer);resolve(match[1]);} });
    chrome.on('error',reject); chrome.on('exit', code => {clearTimeout(timer);reject(new Error('Chrome exit '+code));});
  });
  const socket = new WebSocket(endpoint);
  await new Promise(r => socket.addEventListener('open',r,{once:true}));
  let nextId=0; const pending=new Map(); const errors=[];
  socket.addEventListener('message',event=>{
    const message=JSON.parse(event.data);
    if(message.id){ const callback=pending.get(message.id); pending.delete(message.id); if(message.error) callback.reject(new Error(JSON.stringify(message.error))); else callback.resolve(message.result); }
    if(message.method==='Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
  });
  const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{ const id=++nextId; pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})); });
  const {targetId}=await send('Target.createTarget',{url:'about:blank'});
  const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
  const call=(method,params)=>send(method,params,sessionId);
  await call('Runtime.enable'); await call('Page.enable');
  const evaluate=async expression=>{
    const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if(result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description||JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await call('Page.addScriptToEvaluateOnNewDocument',{source:'window.alerts=[];window.alert=message=>alerts.push(message);window.confirm=()=>true;'});
  const origin='http://127.0.0.1:'+server.address().port;
  const reload=async()=>{ await call('Page.navigate',{url:origin}); for(let i=0;i<100;i++){if(await evaluate("document.readyState==='complete' && typeof state!=='undefined'"))return; await sleep(100);}throw new Error('Page did not load');};
  await reload();
  const newPage = async () => {
    const {targetId: pageId} = await send('Target.createTarget', {url:'about:blank'});
    const {sessionId: pageSession} = await send('Target.attachToTarget', {targetId:pageId,flatten:true});
    const pageCall = (method,params) => send(method,params,pageSession);
    await pageCall('Runtime.enable'); await pageCall('Page.enable');
    await pageCall('Page.addScriptToEvaluateOnNewDocument', {source:'window.alerts=[];window.alert=message=>alerts.push(message);window.confirm=()=>true;'});
    const pageEvaluate = async expression => {
      const result = await pageCall('Runtime.evaluate', {expression,awaitPromise:true,returnByValue:true});
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    await pageCall('Page.navigate', {url:origin});
    for (let i=0;i<100;i++) { if(await pageEvaluate("document.readyState==='complete' && typeof state!=='undefined'")) break; await sleep(100); }
    return {evaluate:pageEvaluate,call:pageCall,close:()=>send('Target.closeTarget',{targetId:pageId})};
  };
  return {evaluate,call,send,reload,newPage,errors,origin,async close(){socket.close();chrome.kill();server.close();await sleep(300);rmSync(profile,{recursive:true,force:true,maxRetries:3});}};
}
module.exports = {launch,assert,sleep};
