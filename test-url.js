const text = 'הגיעה אליך קבלה מ שילב בהתאם למדיניות הפרטיות: https://wee.ai//l/shi\nלצפייה: https://wee.ai/r/6RoyYpbZJkqtpQkzNFZ2MQshi';

const RECEIPT = /לצפ|לצפיה|לצפייה|חשבונ|receipt|invoice|view/i;
const SKIP = /פרטי[וו]?ת|privacy|תקנון|terms|policy|legal|הסכם|תנאי|ביטול|cancel/i;

const matches = [...text.matchAll(/https?:\/\/[^\s\u200B\u200C\u200D\uFEFF"'<>]+/g)];
const urls = matches.map(m => ({ url: m[0].replace(/[.,;!?)\]]+$/, ''), index: m.index ?? 0 }));

console.log('=== URL Analysis ===');
urls.forEach(({url, index}) => {
  const before = text.slice(Math.max(0, index - 40), index);
  const r = RECEIPT.test(before);
  const s = SKIP.test(before);
  console.log('URL:', url);
  console.log('  Before:', JSON.stringify(before));
  console.log('  RECEIPT:', r, '| SKIP:', s, '| Pass1 wins:', r && !s);
});

// Simulate
let result = null;
for (const {url, index} of urls) {
  const before = text.slice(Math.max(0, index - 40), index);
  if (RECEIPT.test(before) && !SKIP.test(before)) { result = 'Pass1: ' + url; break; }
}
if (!result) for (const {url, index} of urls) {
  const before = text.slice(Math.max(0, index - 60), index);
  if (!SKIP.test(before)) { result = 'Pass2: ' + url; break; }
}
if (!result) result = 'Pass3: ' + urls[urls.length-1].url;
console.log('\nFINAL =>', result);
