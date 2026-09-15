import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function findSourceFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...findSourceFiles(full));
    } else if (entry.endsWith('.ts') || entry.endsWith('.js')) {
      results.push(full);
    }
  }
  return results;
}

const root = join(import.meta.dirname, '..');
const files = findSourceFiles(join(root, 'src'));
const bunPatterns = [/\bBun\./g, /from\s+['"]bun:/g, /import\.meta\.main\b/g];
let found = 0;

for (const file of files) {
  const content = readFileSync(file, 'utf8');
  for (const pattern of bunPatterns) {
    pattern.lastIndex = 0;
    const matches = content.match(pattern);
    if (matches) {
      console.error(`FAIL: ${file} contains Bun API: ${matches.join(', ')}`);
      found += matches.length;
    }
  }
}

if (found > 0) {
  console.error(`\n${found} Bun API usage(s) found. Remove before packaging.`);
  process.exit(1);
} else {
  console.log('OK: No Bun API usage found in src/');
}
