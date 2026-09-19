import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TranslationScheduler, prepareOutgoingText, canClearSentDraft } from '../src/services/translationRuntime.ts';

const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('incoming work is deduplicated, concurrency bounded, and abandoned queued jobs never call provider', async () => {
  const scheduler = new TranslationScheduler(2);
  const a=deferred(), b=deferred(); let calls=0; const seen=[];
  scheduler.subscribe('a', () => {calls++; return a.promise;}, r=>seen.push(r.text));
  scheduler.subscribe('a', () => {throw Error('duplicate call');}, r=>seen.push(r.text));
  scheduler.subscribe('b', () => {calls++; return b.promise;}, ()=>{});
  const cancel=scheduler.subscribe('hidden', async()=>{calls++;return 'must not run';}, ()=>{});
  cancel(); await tick(); assert.equal(calls,2);
  a.resolve('translated'); b.resolve('second'); await tick();
  assert.deepEqual(seen,['translated','translated']); assert.equal(calls,2);
  scheduler.subscribe('a', ()=>{throw Error('cache missed');},r=>assert.equal(r.text,'translated'));
});

test('edited text/generation key detaches stale completion, failures stay cached until retry', async () => {
  const scheduler=new TranslationScheduler(); const old=deferred(); const seen=[];
  const unsubscribe=scheduler.subscribe('account:old-text:config1',()=>old.promise,r=>seen.push(r));
  unsubscribe();
  scheduler.subscribe('account:new-text:config2',async()=> 'fresh',r=>seen.push(r.text));
  old.resolve('stale'); await tick(); assert.deepEqual(seen,['fresh']);
  let attempts=0;
  scheduler.subscribe('failed',async()=>{attempts++;throw Error('provider down');},()=>{}); await tick();
  scheduler.subscribe('failed',async()=>{attempts++;return 'unexpected';},r=>assert.match(r.error,/provider down/));
  assert.equal(attempts,1);
  scheduler.forget('failed'); scheduler.subscribe('failed',async()=>{attempts++;return 'retry success';},()=>{}); await tick(); assert.equal(attempts,2);
});

test('outgoing failure never falls back to original, endpoint change aborts, fresh drafts cannot be cleared', async () => {
  let sent=0;
  await assert.rejects(async()=> {const text=await prepareOutgoingText('original','zh',async()=>{throw Error('no provider');},()=>true); sent++; return text;},/no provider/);
  assert.equal(sent,0);
  await assert.rejects(prepareOutgoingText('caption','zh',async()=> '译文',()=>false),/connection changed/);
  await assert.rejects(prepareOutgoingText('caption','zh',async()=> '   ',()=>true),/empty/);
  assert.equal(await prepareOutgoingText('caption','zh',async()=> '译文',()=>true),'译文');
  assert.equal(canClearSentDraft({context:'a',revision:1},{context:'b',revision:1}),false);
  assert.equal(canClearSentDraft({context:'a',revision:1},{context:'a',revision:2}),false);
  assert.equal(canClearSentDraft({context:'a',revision:1},{context:'a',revision:1}),true);
});

test('cache entry and byte budgets evict safely instead of growing without bound', async()=> {
  const scheduler=new TranslationScheduler(2,4,1,128); let calls=0;
  const subscribe=key=>scheduler.subscribe(key,async()=>{calls++;return key;},()=>{});
  subscribe('first'); await tick(); subscribe('second'); await tick(); subscribe('first'); await tick(); assert.equal(calls,3);
  subscribe('x'.repeat(256)); await tick(); subscribe('x'.repeat(256)); await tick(); assert.equal(calls,5);
});

test('provider generation changed while translation runs aborts send',async()=> {
  const deferredTranslation=deferred(); let generation=1; const captured=generation; let sends=0;
  const sending=prepareOutgoingText('original','zh',()=>deferredTranslation.promise,()=>generation===captured).then(()=>sends++);
  generation=2; deferredTranslation.resolve('old model output');
  await assert.rejects(sending,/settings or connection changed/); assert.equal(sends,0);
});
