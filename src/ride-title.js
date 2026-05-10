export function titleFromFileName(fileName) {
  if (typeof fileName !== 'string') return '';
  return fileName
    .replace(/\.[^.]+$/, '')
    .replace(/_/g, ' ')
    .trim();
}
