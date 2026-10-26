import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ChannelService} from '../src/channel_service.mjs';
import {channelAtomicReview,channelReviewProgress} from '../src/channel_review.mjs';

// Pure in-memory regressions: the save and CLI runners never touch disk/network.
const owner='synthetic-owner',id='abcdef123456';
const key=createHash('sha256').update(JSON.stringify(['private',owner])).digest('hex');
const event={id:'synthetic-event',content:'/channel-confirm '+id,author:{user_openid:owner}};
function fixture(){
  let release,entered,currentOwner=owner,calls=0,saves=0;
  const ready=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const service=new ChannelService({root:process.cwd(),getOwner:()=>currentOwner,run:async()=>{calls++;return {success:true};}});
  const proposal={scope:key,owner,action:'manage.update-guild-info',parameters:{'guild-id':'123','guild-name':'合成名称'},status:'pending',at:Date.now()};
  service.state={sessions:{},completed:[],proposals:{[id]:proposal}};
  service.commands=[{name:'manage.update-guild-info',flags:[{name:'guild-id',type:'string',required:true},{name:'guild-name',type:'string'}]}];
  proposal.atomicReview=channelAtomicReview(service.commands[0],proposal.parameters);
  proposal.reviewProgress=channelReviewProgress(proposal.atomicReview.text);proposal.reviewProgress.nextPage=proposal.reviewProgress.pageCount;
  service.save=async()=>{if(++saves===1){entered();await gate;}};
  return {service,proposal,ready,release:()=>release(),calls:()=>calls,changeOwner:()=>{currentOwner='different-owner';}};
}

test('atomic confirm invalidated while persisting executing never starts its external write',async()=>{
  const f=fixture();let valid=true;
  const work=f.service.process(event,async()=>{},()=>valid);
  await f.ready;assert.equal(f.proposal.status,'executing');valid=false;f.release();await work;
  assert.equal(f.calls(),0);assert.equal(f.proposal.status,'canceled');
  await f.service.process(event,async()=>{});assert.equal(f.calls(),0);
});

test('atomic confirm observes forget epoch even when the caller uses default valid',async()=>{
  const f=fixture(),work=f.service.process(event,async()=>{});
  await f.ready;await f.service.forget({...event,content:'/forget'});f.release();await work;
  assert.equal(f.calls(),0);assert.equal(f.proposal.status,'canceled');
});

test('atomic confirm refuses an owner changed while the execution marker is saving',async()=>{
  const f=fixture(),work=f.service.process(event,async()=>{});
  await f.ready;f.changeOwner();f.release();await work;
  assert.equal(f.calls(),0);assert.equal(f.proposal.status,'canceled');
});

test('atomic confirm still executes once when owner, epoch and validity remain current',async()=>{
  const f=fixture(),work=f.service.process(event,async()=>{});
  await f.ready;assert.equal(f.calls(),0);f.release();await work;
  assert.equal(f.calls(),1);assert.equal(f.proposal.status,'completed');
  await f.service.process(event,async()=>{});assert.equal(f.calls(),1);
});
