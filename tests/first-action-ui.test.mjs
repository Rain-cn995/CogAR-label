import assert from "node:assert/strict";
import test from "node:test";
import { mountPage, text } from "./helpers/component-harness.mjs";

test("component handlers capture, update, validate, export, reimport, remove/undo, and restore drafts", async () => {
  const storage=new Map(); const downloads=[]; const previous={window:globalThis.window,document:globalThis.document,create:URL.createObjectURL,revoke:URL.revokeObjectURL};
  globalThis.window={localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)},addEventListener(){},removeEventListener(){},confirm:()=>true};
  globalThis.document={createElement:()=>({click(){}})};
  URL.createObjectURL=blob=>{if(blob.type==='text/csv;charset=utf-8')downloads.push(blob);return 'blob:synthetic';};URL.revokeObjectURL=()=>{};
  const iso=s=>new Date(Date.parse('2026-08-17T14:00:00Z')+s*1000).toISOString();
  const csv='participant_id,sheet,plan_id,step,step_name,action,event_timestamp_iso,reliance,review_decision\n1,p37,boba,,Task,start,'+iso(0)+',,\n1,p37,boba,2,Sugar,AI audio,'+iso(2)+',,\n1,p37,boba,2,Sugar,AI audio end,'+iso(6)+',,\n1,p37,boba,2,Sugar,AI accepted,'+iso(10)+',over_rely,accept\n1,p37,boba,3,Correct,AI audio,'+iso(12)+',,\n1,p37,boba,3,Correct,AI accepted,'+iso(18)+',app_rely,accept';
  const app=await mountPage();
  const find=(fn)=>{const node=app.nodes().find(fn);assert.ok(node,'Expected rendered element');return node;};
  const button=(label)=>find(n=>n.type==='button'&&text(n)===label);
  const click=async(label)=>{const b=button(label);assert.ok(!b.props.disabled,`${label} enabled`);await app.act(()=>b.props.onClick());};
  const upload=async(contents,name='events.csv')=>app.act(()=>find(n=>n.type==='input'&&n.props.accept?.startsWith('.csv')).props.onChange({target:{files:[{name,text:async()=>contents}],value:'fake'}}));
  const rows=()=>app.nodes().filter(n=>n.type==='tr'&&n.props.className!==undefined);
  const markers=()=>rows().filter(n=>n.props.className.includes('is-first-action'));
  const edit=async(row)=>app.act(()=>row.props.children.flat(Infinity).find(n=>n?.type==='td'&&n.props.className==='time-column').props.children.props.children[1].props.onClick());
  const notice=()=>text(find(n=>n.props.className==='review-notice'));
  const output=()=>text(find(n=>n.type==='section'&&n.props['aria-label']==='First action annotation'));
  try {
    await upload(csv);assert.equal(rows().length,6);
    await app.act(()=>find(n=>n.type==='input'&&n.props.accept==='video/*').props.onChange({target:{files:[{name:'test.mp4',size:100,lastModified:1,type:'video/mp4'}]}}));
    const video={readyState:2,seeking:false,duration:30,currentTime:0,pause(){},focus(){}};
    find(n=>n.type==='video').props.ref.current=video;
    await app.act(()=>find(n=>n.type==='video').props.onLoadedMetadata({currentTarget:video}));
    await edit(rows().find(n=>text(n).includes('AI audio')&&!text(n).includes('end')&&text(n).includes('Sugar')));
    assert.equal(button('Record first action').props.disabled,true);
    await app.act(()=>find(n=>n.type==='div'&&n.props.className==='clock-confirmation').props.children[0].props.children[0].props.onChange({target:{checked:true}}));
    video.currentTime=4.125;await click('Record first action');
    assert.equal(markers().length,1);assert.ok(output().includes(iso(4.125)));assert.ok(output().includes('2.125 s from AI audio onset'));
    assert.ok(!text(markers()[0]).includes('AcceptReject'));
    video.currentTime=5;await click('Update from video');assert.equal(markers().length,1);assert.ok(output().includes(iso(5)));
    await app.act(()=>find(n=>n.props.className==='standard-time-input').props.onChange({target:{value:iso(1)}}));await click('Apply ISO');assert.match(notice(),/before AI onset/);assert.ok(output().includes(iso(5)));
    await app.act(()=>find(n=>n.type==='input'&&n.props.placeholder==='2026-08-17T14:23:06.881Z').props.onChange({target:{value:iso(1)}}));
    await click('Apply standard time');
    await click('Export edited CSV');assert.equal(downloads.length,0);assert.match(notice(),/clock/);
    await app.act(()=>find(n=>n.type==='div'&&n.props.className==='clock-confirmation').props.children[0].props.children[0].props.onChange({target:{checked:true}}));
    await click('Recalculate from captured frame');assert.ok(output().includes(iso(6)));
    await app.act(()=>find(n=>n.type==='input'&&n.props.placeholder==='2026-08-17T14:23:06.881Z').props.onChange({target:{value:iso(0)}}));
    await click('Apply standard time');
    await app.act(()=>find(n=>n.type==='div'&&n.props.className==='clock-confirmation').props.children[0].props.children[0].props.onChange({target:{checked:true}}));
    await click('Recalculate from captured frame');assert.ok(output().includes(iso(5)));
    await app.act(()=>find(n=>n.props['aria-label']==='Annotation note').props.onChange({target:{value:'first reach'}}));
    await click('Export edited CSV');assert.equal(downloads.length,1);const exported=await downloads[0].text();assert.ok(exported.includes('source_ai_event_id'));assert.ok(exported.includes('first reach'));
    await upload(exported,'reimport.csv');assert.equal(markers().length,1);await edit(markers()[0]);assert.ok(!app.nodes().some(n=>n.props.className==='annotation-errors'));
    await click('Remove first action');assert.equal(markers().length,0);await click('Undo removal');assert.equal(markers().length,1);
    await edit(rows().find(n=>text(n).includes('Correct')&&text(n).includes('AI audio')));assert.equal(button('Record first action').props.disabled,true);
    await edit(markers()[0]);await app.act(()=>find(n=>n.props['aria-label']==='Annotation note').props.onChange({target:{value:'draft note'}}));
    await click('Remove first action');await click('Reset');await upload(exported,'reimport.csv');assert.equal(markers().length,0);await click('Undo removal');await edit(markers()[0]);assert.equal(find(n=>n.props['aria-label']==='Annotation note').props.value,'draft note');
    // The original final decision and original AI timestamp are preserved.
    assert.ok(rows().some(n=>text(n).includes('AI accepted')&&text(n).includes(iso(10))));
    // Excluding the source must prevent exporting its dependent marker.
    const sourceRow=rows().find(n=>text(n).includes('Sugar')&&text(n).includes('AI audio')&&!text(n).includes('end'));
    const toggle=sourceRow.props.children[0].props.children;
    await app.act(()=>toggle.props.onClick());await click('Export edited CSV');assert.equal(downloads.length,1);assert.match(notice(),/excluded/);
  } finally {
    app.dispose();globalThis.window=previous.window;globalThis.document=previous.document;URL.createObjectURL=previous.create;URL.revokeObjectURL=previous.revoke;
  }
});
