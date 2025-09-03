#!/usr/bin/env node

import esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { mkdirSync, existsSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const pkg = require(path.resolve(__dirname, 'package.json'));

// 确保bin目录存在
const binDir = path.join(__dirname, 'bin');
if (!existsSync(binDir)) {
  mkdirSync(binDir, { recursive: true });
}

const buildConfig = {
  entryPoints: ['packages/cli/index.ts'],
  bundle: true,
  outfile: 'bin/blade.js',
  platform: 'node',
  format: 'esm',
  target: 'node16',
  external: [
    // Node.js built-ins
    'fs',
    'path',
    'os',
    'crypto',
    'util',
    'events',
    'child_process',
    'https',
    'http',
    'url',
    'stream',
    'buffer',
    'zlib',
    // External dependencies that should not be bundled
    'react',
    'react-dom',
    'ink',
    'commander',
    'chalk',
    'inquirer',
    'ws',
    'axios',
    'openai',
    '@modelcontextprotocol/sdk'
  ],
  alias: {
    '@blade-ai/core': path.resolve(__dirname, 'packages/core/src/index.ts'),
  },
  define: {
    'process.env.CLI_VERSION': JSON.stringify(pkg.version),
  },
  banner: {
    js: `import { createRequire } from 'module';\nconst require = createRequire(import.meta.url);\nglobalThis.__filename = require('url').fileURLToPath(import.meta.url);\nglobalThis.__dirname = require('path').dirname(globalThis.__filename);`,
  },
  loader: { '.node': 'file' },
  minify: false, // Keep readable for debugging
  sourcemap: true,
};

// Build function
async function build() {
  try {
    console.log('🔨 Building Blade CLI...');
    await esbuild.build(buildConfig);
    console.log('✅ Build completed successfully!');
    console.log(`📦 Output: ${buildConfig.outfile}`);
    
    // Make the output executable
    const fs = await import('fs');
    try {
      fs.chmodSync(buildConfig.outfile, '755');
      console.log('🔧 Set executable permissions');
    } catch (err) {
      console.warn('⚠️  Could not set executable permissions:', err.message);
    }
  } catch (error) {
    console.error('❌ Build failed:', error);
    process.exit(1);
  }
}

// Watch function for development
async function watch() {
  try {
    console.log('👀 Watching for changes...');
    const context = await esbuild.context(buildConfig);
    await context.watch();
    console.log('🔄 Watch mode enabled');
  } catch (error) {
    console.error('❌ Watch failed:', error);
    process.exit(1);
  }
}

// Main execution
const args = process.argv.slice(2);
if (args.includes('--watch')) {
  watch();
} else {
  build();
}