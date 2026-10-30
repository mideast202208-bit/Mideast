import test from 'node:test';
import assert from 'node:assert/strict';
import { renderFixture,fixture } from './ui-fixture.mjs';
test('actual frontend renders every application page with empty persisted data',async()=>{
  const ui=await renderFixture();
  for(const page of ['dashboard','contacts','leads','inbox','tickets','tasks','quotes','finance','studio','automations','users','integrations','audit','security','operations','app:qa-students']){
    const html=ui.page(page);assert.ok(html.includes('class="shell"'));assert.ok(!html.includes('undefined'));
  }
});
test('custom app labels and renamed stages are HTML escaped',async()=>{
  const data=structuredClone(fixture);data.apps[0].name='<img src=x onerror=alert(1)>';
  data.pipeline[0].label='<script>alert(1)</script>';
  const ui=await renderFixture(data),html=ui.page('app:qa-students');
  assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('<img src=x'));
  const board=ui.page('leads');assert.ok(!board.includes('<script>alert'));assert.ok(board.includes('&lt;script&gt;'));
});
test('studio shows persisted form order and relation selectors in original frontend',async()=>{
  const data=structuredClone(fixture);data.appFields=[{id:'f1',app_id:'qa-students',field_key:'guardian',label:'ولي الأمر',type:'relation',relation_target:'contact',required:1,options:'[]'}];
  const ui=await renderFixture(data),html=ui.studio('qa-students');
  assert.ok(html.includes('ولي الأمر'));assert.ok(html.includes('data-field-id="f1"'));assert.ok(html.includes('اسحب الحقول'));assert.ok(html.includes('اختر سجلًا'));
});
