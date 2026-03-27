// Test the RTL mirror detection and fix
const MIRRORED_MARKERS = ["מולשתל","תינובשח","ךירואת","יראת"];

function isMirroredOcrText(text) {
  const sample = text.slice(0, 600);
  return MIRRORED_MARKERS.some(m => sample.includes(m));
}

function fixMirroredOcrText(text) {
  return text.split("\n").map(line => {
    const trimmed = line.trim();
    if (!trimmed) return "";
    const rev = trimmed.split("").reverse().join("");
    return rev.replace(/\d[\d.:,/\-]*\d|\d/g, m => m.split("").reverse().join(""));
  }).join("\n");
}

// The actual OCR output from the MAX receipt
const mirroredInput = `ae PT TD Ce
> 1003040627 חשברנ יח מם/קבלה
| לכנגוד: :קוח כל" בארות 'צ7ק112000-

5 9720000474458 בלסטרים לדלרים 28 500
0 4902505154529 ורסט"? 187-העחור 3.90 >
3 | 4902505085765 8171990 לש כחול.. 7.00 >
ה 4006381492867 דש הרגשה < Boss 10.90
3 | /72999990994 111 עשי טיפקם - 9.90
מולשתל 64.60
55.47 מ"טמ ביוח
9.85 %00.81 מ"עמ
מולש
14.64 ירארשא`;

console.log("=== TEST: isMirroredOcrText ===");
console.log("Detected:", isMirroredOcrText(mirroredInput));

console.log("\n=== TEST: fixMirroredOcrText ===");
const fixed = fixMirroredOcrText(mirroredInput);
console.log(fixed);

console.log("\n=== KEY LINES AFTER FIX ===");
fixed.split("\n").slice(0, 8).forEach((l,i) => console.log(`${i}: "${l}"`));

// Verify amount extraction
const hasTotal = fixed.includes("לתשלום") || fixed.includes("64.60");
console.log("\nContains לתשלום or 64.60:", hasTotal);
