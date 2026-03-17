const fs = require('fs');
const pdf = require('pdf-parse');
let dataBuffer = fs.readFileSync('D:\\teaching\\עסק\\2025\\12\\דלק.pdf');
pdf(dataBuffer).then(function(data) {
  console.log('Text extracted:', data.text.substring(0, 500));
}).catch(console.error);
