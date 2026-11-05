/**
 * Webpack plugin to inject module resolution code at the very beginning of the bundle
 * This ensures extension_node_modules is in the module resolution path BEFORE any requires execute
 */

class ModuleResolverPlugin {
  apply(compiler) {
    compiler.hooks.compilation.tap('ModuleResolverPlugin', (compilation) => {
      // Use ADDITIONAL stage to inject code at the very end, but before optimization
      compilation.hooks.processAssets.tap(
        {
          name: 'ModuleResolverPlugin',
          // Use OPTIMIZE stage which runs after code generation but before final optimization
          stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE,
        },
        (assets) => {
          const assetNames = Object.keys(assets);
          const extensionJsAsset = assetNames.find(name => name === 'extension.js' || name.endsWith('/extension.js'));
          
          if (extensionJsAsset) {
            const asset = assets[extensionJsAsset];
            const originalSource = asset.source();
            
            // Get source as string
            let source = typeof originalSource === 'string' 
              ? originalSource 
              : originalSource.source();
            
            // Inject module resolution code at the VERY beginning (before any other code)
            const moduleResolutionCode = `// CRITICAL: Module resolution setup must be FIRST - before any requires execute
(function() {
  try {
    const path = require('path');
    const fs = require('fs');
    const Module = require('module');
    
    const extensionRoot = path.resolve(__dirname, '..');
    const extensionNodeModules = path.join(extensionRoot, 'extension_node_modules');
    
    if (fs.existsSync(extensionNodeModules)) {
      // Patch Module._nodeModulePaths globally for ALL modules
      const originalNodeModulePaths = Module._nodeModulePaths;
      if (originalNodeModulePaths && typeof originalNodeModulePaths === 'function') {
        try {
          Module._nodeModulePaths = function(from) {
            const paths = originalNodeModulePaths.call(this, from);
            if (paths && Array.isArray(paths) && !paths.includes(extensionNodeModules)) {
              paths.unshift(extensionNodeModules);
            }
            return paths;
          };
        } catch (e) {
          // Fallback if patching fails
        }
      }
      
      // Also set NODE_PATH
      const nodePath = process.env.NODE_PATH || '';
      if (!nodePath.split(path.delimiter).includes(extensionNodeModules)) {
        process.env.NODE_PATH = extensionNodeModules + (nodePath ? path.delimiter + nodePath : '');
      }
      
      // Modify current module paths
      if (module.paths && Array.isArray(module.paths) && !module.paths.includes(extensionNodeModules)) {
        module.paths.unshift(extensionNodeModules);
      }
    }
  } catch (e) {
    console.error('[ModuleResolverPlugin] Failed to setup module resolution:', e);
  }
})();

`;
            
            // Prepend the module resolution code - this ensures it runs FIRST
            source = moduleResolutionCode + source;
            
            // Update the asset using RawSource
            const { RawSource } = compiler.webpack.sources || require('webpack-sources');
            compilation.updateAsset(extensionJsAsset, new RawSource(source));
          }
        }
      );
    });
  }
}

module.exports = ModuleResolverPlugin;




