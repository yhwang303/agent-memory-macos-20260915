import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const platform = process.argv[2] || 'node22-win-x64';

console.log(`Building agent-memory for ${platform}...`);

console.log('Step 1: TypeScript compile...');
execSync('npx tsc', { stdio: 'inherit' });

console.log('Step 2: esbuild bundle to CJS...');
mkdirSync('release', { recursive: true });
execSync(
  'npx esbuild dist/cli.js --bundle --platform=node --target=node22 --format=cjs --outfile=release/cli.cjs --loader:.node=file',
  { stdio: 'inherit' }
);

const outputName = platform.includes('win') ? 'release/agent-memory.exe' : 'release/agent-memory';

console.log('Step 3: pkg package...');
execSync(
  `npx @yao-pkg/pkg release/cli.cjs --targets ${platform} --output ${outputName} --compress GZip`,
  { stdio: 'inherit' }
);

console.log(`Done! Output: ${outputName}`);
