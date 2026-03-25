const RECEIPT_PATH_HINT = /\/r\/|\/receipt|\/notification|\/doc|\/cms/i;
const PRIVACY_PATH_HINT = /\/l\/|\/privacy|\/terms|\/policy|\/legal/i;
const RECEIPT_KEYWORDS_BEFORE = /לצפ|לצפיה|לצפייה|חשבונ|receipt|invoice|view/i;
const SKIP_KEYWORDS_BEFORE = /פרטי[וו]?ת|privacy|תקנון|terms|policy|legal|הסכם|תנאי|ביטול|cancel/i;

function extractAllUrls(text) {
  const matches = [...text.matchAll(/https?:\/\/[^\s\u200B\u200C\u200D\uFEFF"'<>]+/g)];
  return matches.map(m => m[0].replace(/[.,;!?)\]]+$/, ''));
}

function extractBestUrl(text) {
  const allUrls = extractAllUrls(text);
  if (allUrls.length === 0) return { best: null, all: [], pass: -1 };
  if (allUrls.length === 1) return { best: allUrls[0], all: allUrls, pass: -1 };

  const urlsWithIndex = [...text.matchAll(/https?:\/\/[^\s\u200B\u200C\u200D\uFEFF"'<>]+/g)]
    .map(m => ({ url: m[0].replace(/[.,;!?)\]]+$/, ''), index: m.index ?? 0 }));

  // Pass 0: URL path itself contains receipt hint AND no privacy hint
  for (const { url } of urlsWithIndex) {
    if (RECEIPT_PATH_HINT.test(url) && !PRIVACY_PATH_HINT.test(url))
      return { best: url, all: allUrls, pass: 0 };
  }
  // Pass 1: receipt keyword nearby AND no skip keyword
  for (const { url, index } of urlsWithIndex) {
    const before = text.slice(Math.max(0, index - 40), index);
    if (RECEIPT_KEYWORDS_BEFORE.test(before) && !SKIP_KEYWORDS_BEFORE.test(before))
      return { best: url, all: allUrls, pass: 1 };
  }
  // Pass 2: URL NOT preceded by skip keyword
  for (const { url, index } of urlsWithIndex) {
    const before = text.slice(Math.max(0, index - 60), index);
    if (!SKIP_KEYWORDS_BEFORE.test(before))
      return { best: url, all: allUrls, pass: 2 };
  }
  return { best: allUrls[allUrls.length - 1], all: allUrls, pass: 3 };
}

const tests = [
  {
    name: 'שילב - privacy link first, receipt link second',
    text: 'הגיעה אליך קבלה מ שילב בהתאם למדיניות הפרטיות https://wee.ai/l/shi לצפייה: https://wee.ai/r/2kr5f7MdQ0ObF6gxvcHXPwshi',
    expected: 'https://wee.ai/r/2kr5f7MdQ0ObF6gxvcHXPwshi'
  },
  {
    name: 'KSP - SMS עם קישור notification',
    text: 'התקבלה חשבונית מס וקבלה דיגיטליים מספר 681771 מאת קיי.אס.פי: https://dsdoc.ksp.co.il/notification/139e4f664362062f77682631af37b-d25',
    expected: 'https://dsdoc.ksp.co.il/notification/139e4f664362062f77682631af37b-d25'
  },
  {
    name: 'SuperPharm - receipt link first, privacy second',
    text: 'התקבלה חשבונית חדשה מסופר-פארם https://wee.ai/r/IQW0CDlDRUK1gSzE-mHvHgsph בהתאם למדיניות הפרטיות: https://wee.ai/pages/sph/l',
    expected: 'https://wee.ai/r/IQW0CDlDRUK1gSzE-mHvHgsph'
  },
  {
    name: 'Sonol - Pairzon - לצפייה לפני הקישור',
    text: 'התקבלה חשבונית חדשה מסונול לחצו לצפייה<< https://public.pairzon.com/1155/5pFRMu4vjRckNHBKQVwEF0 בהתאם למדיניות הפרטיות<< https://tinyurl.com/awsonolpriv',
    expected: 'https://public.pairzon.com/1155/5pFRMu4vjRckNHBKQVwEF0'
  },
  {
    name: 'קישור ישיר בלי טקסט',
    text: 'https://dsdoc.ksp.co.il/notification/139e4f664362062f77682631af37b-d25',
    expected: 'https://dsdoc.ksp.co.il/notification/139e4f664362062f77682631af37b-d25'
  },
  {
    name: 'Hermitage - Weezmo - receipt before privacy',
    text: 'הגיעה אליך קבלה מ Hermitage לצפייה: https://wee.ai/r/e4M3XFTCqkKjwKyYLI2pkwRZT8D בהתאם למדיניות https://wee.ai/l/RZT8D',
    expected: 'https://wee.ai/r/e4M3XFTCqkKjwKyYLI2pkwRZT8D'
  },
  {
    name: 'McDigital - McDonald\'s - wee.ai/r',
    text: 'קבלה ירוקה חדשה ממקדונלד\'ס, מס\' הזמנה 1301 לצפייה << https://wee.ai/r/qM-lMpahT0Sw8xTjtHEZgwmcd',
    expected: 'https://wee.ai/r/qM-lMpahT0Sw8xTjtHEZgwmcd'
  },
  {
    name: 'רק URL ישיר של wee.ai/r',
    text: 'https://wee.ai/r/2kr5f7MdQ0ObF6gxvcHXPwshi',
    expected: 'https://wee.ai/r/2kr5f7MdQ0ObF6gxvcHXPwshi'
  },
];

let pass = 0, fail = 0;
for (const t of tests) {
  const result = extractBestUrl(t.text);
  const ok = result.best === t.expected;
  if (ok) pass++; else fail++;
  const icon = ok ? '✅' : '❌';
  console.log(`${icon} [Pass ${result.pass}] ${t.name}`);
  if (!ok) {
    console.log(`   Expected: ${t.expected}`);
    console.log(`   Got:      ${result.best}`);
    console.log(`   All URLs: ${JSON.stringify(result.all)}`);
  }
}
console.log('');
console.log(`${pass}/${pass+fail} tests passed`);
