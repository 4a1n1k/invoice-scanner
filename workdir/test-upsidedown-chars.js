// Test: is 'ULLL UCGL 2 TAU' = upside-down Hebrew 'מזרוו בכפר 23 בע"מ'?

const ocr = 'ULLL UCGL 2 TAU';
const ocrWords = ocr.split(' ');

// Reverse each word AND the whole string to simulate 180deg flip
const ocrReversed = ocr.split('').reverse().join('');
console.log('OCR line:', ocr);
console.log('OCR reversed char-by-char:', ocrReversed);
// UAT 2 LGCU LLLU

// Hebrew upside-down character mappings (Tesseract reads them as Latin):
// מ (mem) -> 'U' or 'n' (looks like U rotated 180)
// ז (zayin) -> 'L' (upside-down looks like reversed L)
// ר (resh) -> 'r' or 'J' 
// ו (vav) -> 'l' or 'L' (thin vertical)
// ב (bet) -> 'G' or 'q' (upside-down bet looks like G)
// כ (kaf) -> 'C' (open kaf looks like C upside-down)
// פ (pe) -> 'U' or 'q'
// ע (ayin) -> 'A' (looks like A upside-down? or Q)
// ת (tav) -> 'T' or 'n' (tav upside-down = T shape)
// 2 -> '2' upside-down can look like 'S' or stay '2'  
// 3 -> '3' upside-down looks like 'E' or epsilon

// Let's map 'ULLL UCGL 2 TAU' reversed = 'UAT 2 LGCU LLLU'
// U=מ A=ע T=ת -> ת-ע-מ -> "מ'עת" reversed = "תעמ"... no
// Actually word-by-word reversed:
// LLLU -> U+L+L+L reversed = L+L+L+U = ו+ו+ר+מ = "מרוו" or "מזרוו" close!
// LCGU -> U+G+C+L reversed = L+C+G+U = ... 
// 2 -> 23?
// UAT -> T+A+U reversed = U+A+T = מ+ע+ת = "תעמ" -> "בע\"מ"? 

// Simpler test: just reverse the whole OCR output
console.log('');
console.log('Word analysis:');
const words = ocrReversed.trim().split(' ');
words.forEach(w => console.log(' ', w));

console.log('');
console.log('CONCLUSION:');
console.log('UAT = could be ת+א+ו = reversed של תאו or מ+ע+ב = בע"מ');
console.log('LLLU = ו+ו+ר+מ... = מרוו -> מזרוו (ז reads as nothing)');
console.log('UCGL = ל+ג+כ+ו = ולגכ... close to בכפר? No...');
console.log('');
console.log('The Hebrew ל (lamed) looks like L, כ (kaf) like C, פ (pe) like G?, ב (bet) like U?');
console.log('So UCGL backward = LGCU -> ל+כ+פ+ב -> בפכל? No...');
console.log('But with spaces: בכפר 23 -> UCGL €2');
console.log('ב=U, כ=C, פ=G, ר=L -> reversed = L+G+C+U = LGCU upside... -> UCGL forward reading');
console.log('YES! ב->U, כ->C, פ->G, ר->L makes UCGL = בכפר upside-down!');
console.log('');
console.log('Final mapping:');
console.log('מ->U, ז->L, ר->L, ו->L, ו->L -> ULLL = מזרוו read upside-down forward!');
console.log('ב->U, כ->C, פ->G, ר->L -> UCGL = בכפר read upside-down forward!');  
console.log('2->2, 3->€ -> 2€ = 23 upside-down (3 looks like reversed E/€)');
console.log('ת->T, א->A(missing?), ו->U -> TAU = תאו? or ב->T,ע->A,מ->U = TAU = מ"עב = בע"מ!');
