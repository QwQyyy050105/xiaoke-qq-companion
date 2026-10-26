import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {MentionDirectory,resolveMentionTargets,textWithMentions} from '../src/recipient_resolver.mjs';
import {QQClient} from '../src/qq.mjs';
const speaker=(g,m)=>'member_'+createHash('sha256').update(JSON.stringify([g,m])).digest('hex').slice(0,16);
test('native mention selection resolves only actual same-group participants and excludes bot/everyone',()=>{
 const event={id:'m',group_openid:'g',author:{member_openid:'alice'},turn_messages:[{id:'a',author:{member_openid:'alice'}},{id:'b',author:{member_openid:'bob'},mentions:[{member_openid:'self',is_you:true},{member_openid:'all',scope:'all'}]},{group_openid:'foreign',author:{member_openid:'carol'}}]};
 assert.deepEqual(resolveMentionTargets(event,[speaker('g','bob'),speaker('g','alice'),speaker('g','carol'),speaker('g','self'),speaker('g','all')]),['bob','alice']);
 assert.deepEqual(resolveMentionTargets({...event,group_openid:undefined},[speaker('g','alice')]),[]);
});
test('bounded observed mention memory works for previous group members but never another group',()=>{
 const directory=new MentionDirectory();const e={id:'m',group_openid:'g',author:{member_openid:'alice'}};directory.observe(e);
 const current={id:'n',group_openid:'g',author:{member_openid:'bob'}};
 assert.deepEqual(directory.resolve(current,[speaker('g','alice')]),['alice']);
 assert.deepEqual(directory.resolve({...current,group_openid:'h'},[speaker('g','alice')]),[]);
 directory.forget('g');assert.deepEqual(directory.resolve(current,[speaker('g','alice')]),[]);
});
test('native QQ markup is constructed by server, model cannot forge mentions or @all',async()=>{
 const text='<qqbot-at-everyone /> <qqbot-at-user id="outsider" /> <@outsider> hello';
 assert.equal(textWithMentions(text,['actual','actual','bad"/>']),'<qqbot-at-user id="actual" />    hello');
 const client=new QQClient('app','unused');const sent=[];client.api=async(path,method,payload)=>{sent.push(payload);return {id:'actual-receipt'};};
 await client.reply({group_openid:'g',id:'i'},text,1,{mentions:['actual']});
 assert.match(sent[0].content,/^<qqbot-at-user id="actual" \/>/);assert.doesNotMatch(sent[0].content,/outsider|everyone/);
 await client.reply({id:'i',author:{user_openid:'owner'}},text,1,{mentions:['actual']});assert.doesNotMatch(sent[1].content,/qqbot-at/);
});
