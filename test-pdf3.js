const fs = require('fs');
const pdf = require('pdf-parse');

const dataBuffer = fs.readFileSync('D:\\teaching\\עסק\\2025\\12\\דלק.pdf');

pdf(dataBuffer).then(function(data) {
    if (data.text && data.text.trim().length > 0) {
        console.log('SUCCESS: Extracted text length:', data.text.length);
        console.log('Sample text:', data.text.substring(0, 500));
    } else {
        console.log('FAIL: No text extracted. The PDF might be a scanned image.');
    }
}).catch(function(err) {
    console.error('ERROR extracting text:', err);
});
