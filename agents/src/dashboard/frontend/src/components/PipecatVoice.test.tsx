import React from 'react';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {PipecatVoice} from './PipecatVoice';
test('Pipecat voice presents explicit connect control and speaker element',()=>{
 const html=renderToStaticMarkup(<PipecatVoice language="ru" />);
 assert.ok(html.includes('Start conversation'));
 assert.ok(html.includes('<audio'));
 assert.ok(html.includes('role="status"'));
 assert.ok(!html.includes('Connected'));
});
