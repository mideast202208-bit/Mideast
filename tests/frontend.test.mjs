import test from 'node:test';
import assert from 'node:assert/strict';
import { renderFixture,fixture } from './ui-fixture.mjs';
test('actual frontend renders every application page with empty persisted data',async()=>{
  const ui=await renderFixture();
  for(const page of ['dashboard','contacts','leads','inbox','tickets','tasks','quotes','finance','studio','automations','users','integrations','audit','security','operations','hub','registrations','social','templates','lab','app:qa-students']){
    const html=ui.page(page);assert.ok(html.includes('class="shell"'));assert.ok(!html.includes('undefined'));
  }
});
test('custom app labels and renamed stages are HTML escaped',async()=>{
  const data=structuredClone(fixture);data.apps[0].name='<img src=x onerror=alert(1)>';
  data.pipeline[0].label='<script>alert(1)</script>';
  const ui=await renderFixture(data),html=ui.page('app:qa-students');
  assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('<img src=x'));
  const board=ui.recordMode('leads','board');assert.ok(!board.includes('<script>alert'));assert.ok(board.includes('&lt;script&gt;'));
});
test('studio shows persisted form order and relation selectors in original frontend',async()=>{
  const data=structuredClone(fixture);data.appFields=[{id:'f1',app_id:'qa-students',field_key:'guardian',label:'ولي الأمر',type:'relation',relation_target:'contact',required:1,options:'[]'}];
  const ui=await renderFixture(data),html=ui.studio('qa-students');
  assert.ok(html.includes('ولي الأمر'));assert.ok(html.includes('data-field-id="f1"'));assert.ok(html.includes('اسحب الحقول'));assert.ok(html.includes('اختر سجلًا'));
});

test('channel hub and reply templates escape untrusted profile and message text',async()=>{
  const data=structuredClone(fixture);
  data.hub={settings:{enabled:true},channels:[{channel:'facebook',state:'disabled'}],links:{facebook:'https://example.test/?x=\"onmouseover=alert(1)'},replies:[{id:'reply-fixture',name:'<img src=x onerror=alert(1)>',body:'<script>alert(1)</script>',category:'عام'}]};
  const ui=await renderFixture(data),html=ui.page('templates');
  assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>alert(1)'));
  assert.ok(!ui.page('hub').includes('x=\"onmouseover=alert(1)'));
});
