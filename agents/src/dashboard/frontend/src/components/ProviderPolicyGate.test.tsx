import React from 'react';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {ProviderPolicyGate} from './ProviderPolicyGate';
test('provider controls render only after confirmed user-editable policy',()=>{
 for(const state of ['loading','error','deployment'] as const){
  const html=renderToStaticMarkup(<ProviderPolicyGate state={state}><input aria-label="API key" /></ProviderPolicyGate>);
  assert.ok(!html.includes('<input'));assert.ok(html.includes('role="status"'));
 }
 assert.ok(renderToStaticMarkup(<ProviderPolicyGate state="user"><input /></ProviderPolicyGate>).includes('<input'));
});
