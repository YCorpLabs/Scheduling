import test from 'node:test';
import assert from 'node:assert/strict';
import {analyticsMarkup} from '../public/analytics-ui.js';
test('analytics presents activity counts and privacy limits without unique-visitor or cohort conversion claims',()=>{
 const markup=analyticsMarkup({period:{from:'2026-11-01',to:'2026-11-30'},totals:{pageViews:20,bookingRequests:3,confirmed:2,cancelled:1},sources:{direct:20},series:[{day:'2026-11-01',pageViews:20}],trackingStartedAt:Date.UTC(2026,10,1)});
 assert.match(markup,/Repeat visits count again/);assert.match(markup,/activity during this period/);assert.match(markup,/90 days/);assert.match(markup,/No visitor identifiers/);assert.doesNotMatch(markup,/unique visitors|conversion rate/i);
});
test('analytics escapes labels and constrains displayed counts before creating markup',()=>{
 const markup=analyticsMarkup({period:{from:'<img src=x onerror=alert(1)>',to:'x'},totals:{pageViews:'<script>'},sources:{email:-1},series:[]});assert.ok(!markup.includes('<img'));assert.ok(markup.includes('&lt;img'));assert.ok(!markup.includes('<script>'));assert.ok(!markup.includes('>-1<'));
});
