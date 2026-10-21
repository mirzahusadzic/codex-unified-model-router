// Split TOML text into logical lines: a physical line plus the continuation
// lines of any multi-line string it opens. Comments and single-line strings
// are scanned past, so quotes inside them never open a string. Joining the
// result with "\n" restores the text.
export function logicalLines(text) {
  const lines = [];
  let open = null;
  for (const line of text.split(/\r?\n/)) {
    if (open) lines[lines.length - 1] += `\n${line}`;
    else lines.push(line);
    open = openDelimiterAfter(line, open);
  }
  return lines;
}

export const managedKeysMarker = '# BEGIN codex-unified-router managed keys';

// A managed block exists only as a real marker line, never as string content.
export function hasManagedKeysMarker(text) {
  return logicalLines(text).some(line => line.trim() === managedKeysMarker);
}

// Return the multi-line delimiter (`"""` or `'''`) still open after `line`.
function openDelimiterAfter(line, open) {
  let index = 0;
  while (index < line.length) {
    if (open) {
      const close = findClosing(line, index, open);
      if (close < 0) return open;
      // Up to two quotes may directly precede the closing delimiter.
      index = close + 3;
      while (index < line.length && index - close < 5 && line[index] === open[0]) index += 1;
      open = null;
      continue;
    }
    const char = line[index];
    if (char === '#') return null;
    if (char !== '"' && char !== "'") {
      index += 1;
      continue;
    }
    if (line.startsWith(char.repeat(3), index)) {
      open = char.repeat(3);
      index += 3;
      continue;
    }
    // A single-line string ends at the next unescaped matching quote.
    index += 1;
    while (index < line.length && line[index] !== char) index += char === '"' && line[index] === '\\' ? 2 : 1;
    index += 1;
  }
  return open;
}

function findClosing(line, from, delimiter) {
  for (let index = from; index <= line.length - 3; index += 1) {
    if (delimiter === '"""' && line[index] === '\\') {
      index += 1;
      continue;
    }
    if (line.startsWith(delimiter, index)) return index;
  }
  return -1;
}
