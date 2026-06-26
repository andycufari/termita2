// Bundle src → dist with esbuild. Resolves JSX, keeps deps external (installed
// from package.json), emits a single executable dist/cli.js with a shebang.
import esbuild from 'esbuild';
import fs from 'node:fs';

await esbuild.build({
  entryPoints: ['src/cli.js'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/cli.js',
  jsx: 'automatic',
  // ink/react/etc resolved at runtime from node_modules (not bundled).
  // The shebang from src/cli.js is preserved by esbuild automatically.
  packages: 'external',
  legalComments: 'none',
  logLevel: 'info',
});

fs.chmodSync('dist/cli.js', 0o755);
console.log('built dist/cli.js');
