#!/usr/bin/env node
// Live API tests for POST /api/v1/receipt
const BASE = 'http://localhost:3005/api/v1/receipt';
const KEY  = '6fb6447f6e5f461b86dca1abb68cdc66';

async function test(name, opts) {
  process.stdout.write(`\n[${name}]\n`);
  try {
    const r = await fetch(BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.auth !== false && { 'Authorization': `Bearer ${KEY}` }),
      },
      body: JSON.stringify(opts.body),
    });
    const d = await r.json();
    console.log(`  HTTP ${r.status} | ok=${d.ok} | code=${d.code ?? d.source ?? '-'}`);
    if (d.ok) {
      console.log(`  source:      ${d.source}`);
      console.log(`  amount:      ${d.invoice?.amount}`);
      console.log(`  description: ${d.invoice?.description}`);
      console.log(`  date:        ${d.invoice?.date}`);
      console.log(`  type:        ${d.invoice?.type}`);
      console.log(`  items:       ${d.invoice?.items?.length ?? 0}`);
      console.log(`  timings:     ${JSON.stringify(d.timings)}`);
    } else {
      console.log(`  error: ${d.error}`);
      if (d.suggestion) console.log(`  hint:  ${d.suggestion}`);
      if (d.allUrls?.length) console.log(`  allUrls: ${d.allUrls.join(', ')}`);
    }
  } catch(e) {
    console.log(`  EXCEPTION: ${e.message}`);
  }
}

(async () => {
  // Test 1: no auth
  await test('1-no-auth', { auth: false, body: { text: 'test' } });

  // Test 2: no URL in text
  await test('2-no-url', { body: { text: 'hello no link here' } });

  // Test 3: KSP SMS (single URL - direct)
  await test('3-ksp-url-direct', { body: { text: 'https://dsdoc.ksp.co.il/notification/139e4f664362062f77682631af37b-d25' } });

  // Test 4: Shilav SMS (two URLs - should pick /r/)
  await test('4-shilav-sms', { body: { text: 'הגיעה אליך קבלה מ שילב בהתאם למדיניות הפרטיות https://wee.ai/l/shi לצפייה: https://wee.ai/r/2kr5f7MdQ0ObF6gxvcHXPwshi' } });

  // Test 5: Pairzon Sonol
  await test('5-pairzon-sonol', { body: { text: 'התקבלה חשבונית חדשה מסונול לחצו לצפייה<< https://public.pairzon.com/1155/5pFRMu4vjRckNHBKQVwEF0 בהתאם למדיניות הפרטיות<< https://tinyurl.com/awsonolpriv' } });

  // Test 6: override URL
  await test('6-override-url', { body: {
    text: 'הגיעה אליך קבלה מ שילב https://wee.ai/l/shi https://wee.ai/r/2kr5f7MdQ0ObF6gxvcHXPwshi',
    overrideUrl: 'https://wee.ai/r/2kr5f7MdQ0ObF6gxvcHXPwshi'
  }});

  // Test 7: invalid URL
  await test('7-bad-url', { body: { text: 'https://not-a-real-receipt-site.example.com/invoice/123' } });

  console.log('\n=== DONE ===');
})();
