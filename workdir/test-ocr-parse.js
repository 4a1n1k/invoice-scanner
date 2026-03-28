// Check if OCR output has the total amount and date accessible to LLM
const ocrSample = `[
מזרר בבפר 23 בע"
15/03/2026 20:11:19 517223418 9.11
310.50 :3"nU0 |
`;

// What keywords does the LLM search for?
const TOTAL_KEYWORDS = ['לתשלום', 'Grand Total', 'Total:'];
const found = TOTAL_KEYWORDS.filter(k => ocrSample.includes(k));
console.log('Keywords found:', found);

// The actual total line
const lines = ocrSample.split('\n');
lines.forEach((l, i) => {
  const nums = l.match(/\d+\.\d+/g);
  if (nums) console.log(`Line ${i}: "${l.trim()}" → numbers: ${nums.join(', ')}`);
});

// The issue: '3"nU0' is garbled Hebrew for 'סה"כ'
// So '310.50 :3"nU0' = '310.50 :כ"הס' = 'סה"כ: 310.50'
// The LLM needs to recognize this pattern

// Date check
const dateMatch = ocrSample.match(/\d{2}\/\d{2}\/\d{4}/);
console.log('Date found:', dateMatch ? dateMatch[0] : 'none');

// Amount: largest number in text
const allNums = [];
const numMatches = ocrSample.matchAll(/\b(\d+\.\d+)\b/g);
for (const m of numMatches) allNums.push(parseFloat(m[1]));
console.log('All decimal numbers:', allNums.sort((a,b) => b-a));
console.log('Largest =', Math.max(...allNums), '← should be 310.50');
