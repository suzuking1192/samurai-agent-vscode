/**
 * Copy external dependencies that must be included in the VSIX package
 * These are marked as externals in webpack.config.js and cannot be bundled
 */

const fs = require('fs');
const path = require('path');

const externalDeps = [
  'ws',
  'chrome-remote-interface',
  'bufferutil', // optional dependency of ws
  'utf-8-validate', // optional dependency of ws
];

const sourceDir = path.resolve(__dirname, '..', 'node_modules');
// Copy to extension_node_modules which is included in .vscodeignore
// We'll need to add this to module resolution at runtime
const targetDir = path.resolve(__dirname, '..', 'extension_node_modules');

// For pnpm, we need to resolve the actual package locations
// pnpm uses symlinks, so we need to follow them to the real packages in .pnpm
function resolvePnpmPackage(packageName) {
  const symlinkPath = path.join(sourceDir, packageName);
  const pnpmBase = path.join(sourceDir, '.pnpm');
  
  // First, try to find it directly in .pnpm directory (most reliable)
  if (fs.existsSync(pnpmBase)) {
    try {
      const entries = fs.readdirSync(pnpmBase);
      for (const entry of entries) {
        if (entry.startsWith(`${packageName}@`)) {
          const candidatePath = path.join(pnpmBase, entry, 'node_modules', packageName);
          if (fs.existsSync(candidatePath)) {
            const stat = fs.statSync(candidatePath);
            if (stat.isDirectory()) {
              return candidatePath;
            }
          }
        }
      }
    } catch (err) {
      // Continue to next method
    }
  }
  
  // Second, try to resolve symlink if it exists
  if (fs.existsSync(symlinkPath)) {
    try {
      // Use realpathSync to properly resolve symlinks (handles relative and absolute)
      const realPath = fs.realpathSync(symlinkPath);
      // Verify the resolved path actually exists and is a directory
      if (fs.existsSync(realPath)) {
        const stat = fs.statSync(realPath);
        if (stat.isDirectory()) {
          return realPath;
        }
      }
    } catch (err) {
      // Fallback: check if it's already a directory (not a symlink)
      try {
        const stat = fs.statSync(symlinkPath);
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
          return symlinkPath;
        }
      } catch (statErr) {
        // Ignore
      }
    }
  }
  
  return null;
}

function copyRecursive(src, dest) {
  // Verify source exists
  if (!fs.existsSync(src)) {
    throw new Error(`Source does not exist: ${src}`);
  }
  
  const stat = fs.statSync(src);
  
  if (stat.isDirectory()) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    
    const entries = fs.readdirSync(src);
    for (const entry of entries) {
      // Skip certain directories/files that aren't needed
      if (entry === '.git' || entry === 'test' || entry === 'tests' || 
          entry === '__tests__' || entry === '.github' || entry === 'examples') {
        continue;
      }
      
      const srcPath = path.join(src, entry);
      const destPath = path.join(dest, entry);
      
      try {
        copyRecursive(srcPath, destPath);
      } catch (err) {
        console.warn(`Warning: Could not copy ${srcPath}: ${err.message}`);
      }
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

console.log('Copying external dependencies...');

for (const dep of externalDeps) {
  const targetPath = path.join(targetDir, dep);
  
  // Resolve actual package location (handles pnpm symlinks)
  const resolvedPath = resolvePnpmPackage(dep);
  
  if (!resolvedPath) {
    console.warn(`Warning: ${dep} not found in node_modules, skipping...`);
    continue;
  }
  
  // Verify the resolved path actually exists before trying to copy
  if (!fs.existsSync(resolvedPath)) {
    console.error(`Error: Resolved path for ${dep} does not exist: ${resolvedPath}`);
    process.exit(1);
  }
  
  // Verify it's a directory
  try {
    const stat = fs.statSync(resolvedPath);
    if (!stat.isDirectory()) {
      console.error(`Error: Resolved path for ${dep} is not a directory: ${resolvedPath}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`Error: Cannot stat resolved path for ${dep}: ${resolvedPath} - ${err.message}`);
    process.exit(1);
  }
  
  // Remove existing symlink or directory if it exists
  if (fs.existsSync(targetPath)) {
    try {
      const stat = fs.lstatSync(targetPath);
      if (stat.isSymbolicLink()) {
        fs.unlinkSync(targetPath);
      } else {
        fs.rmSync(targetPath, { recursive: true, force: true });
      }
    } catch (err) {
      console.warn(`Warning: Could not remove existing ${targetPath}: ${err.message}`);
    }
  }
  
  console.log(`  Copying ${dep} from ${resolvedPath}...`);
  try {
    copyRecursive(resolvedPath, targetPath);
    console.log(`  ✓ ${dep} copied`);
  } catch (err) {
    console.error(`  ✗ Failed to copy ${dep}: ${err.message}`);
    console.error(`    Source: ${resolvedPath}`);
    console.error(`    Target: ${targetPath}`);
    process.exit(1);
  }
}

console.log('✓ External dependencies copied successfully');




