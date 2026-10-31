export function parseEnv(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function upsertEnv(text, replacements) {
  const lines = text.split(/\r?\n/);
  for (const [key, value] of replacements) {
    const matcher = new RegExp(`^\\s*(?:export\\s+)?${escapeRegExp(key)}\\s*=`);
    const index = lines.findIndex((line) => matcher.test(line));
    if (index >= 0) {
      lines[index] = `${key}=${value}`;
    } else {
      if (lines.length > 0 && lines.at(-1) !== '') lines.push('');
      lines.push(`${key}=${value}`);
    }
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}
