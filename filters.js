const blockedWords = [
  /\bamk\b/gi,
  /\bsiktir\b/gi,
  /\borospu\b/gi,
  /\bpi[cç]\b/gi,
  /\byarrak\b/gi
];

function cleanText(value, maxLength = 500) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function filterMessage(value) {
  let text = cleanText(value, 500);
  if (/https?:\/\/|www\./i.test(text)) return { text: '', error: 'Sohbette bağlantı paylaşamazsın.' };
  for (const expression of blockedWords) text = text.replace(expression, '•••');
  return text ? { text } : { text: '', error: 'Mesaj boş olamaz.' };
}

module.exports = { cleanText, filterMessage };