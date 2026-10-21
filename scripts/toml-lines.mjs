// Split TOML text into logical lines, keeping each multi-line string with the
// line that opens it, so its contents are never mistaken for keys, tables, or
// managed markers. Joining the result with "\n" restores the text.
export function logicalLines(text) {
  const lines = [];
  let open = null;
  for (const line of text.split(/\r?\n/)) {
    if (open) {
      lines[lines.length - 1] += `\n${line}`;
      if (line.split(open).length % 2 === 0) open = null;
      continue;
    }
    lines.push(line);
    const delimiter = ['"""', "'''"]
      .filter(candidate => line.includes(candidate))
      .sort((left, right) => line.indexOf(left) - line.indexOf(right))[0];
    if (delimiter && line.split(delimiter).length % 2 === 0) open = delimiter;
  }
  return lines;
}
