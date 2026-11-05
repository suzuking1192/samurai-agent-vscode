//@ts-check

'use strict';

const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const ModuleResolverPlugin = require('./scripts/webpack-module-resolver-plugin.js');

//@ts-check
/** @typedef {import('webpack').Configuration} WebpackConfig **/

/**
 * @param {any} env
 * @param {any} argv
 * @returns {WebpackConfig}
 */
module.exports = (env, argv) => {
  const isProduction = argv.mode === 'production';
  
  /** @type WebpackConfig */
  const extensionConfig = {
    target: 'node', // VS Code extensions run in a Node.js-context 📖 -> https://webpack.js.org/configuration/node/
    mode: argv.mode || 'none', // this leaves the source code as close as possible to the original (when packaging we set this to 'production')
    
    // devtool is set conditionally:
    // - Production mode (via --mode production): devtool: false (no source maps)
    // - Development mode (default): devtool: 'source-map' (for debugging)
    // Command line --devtool flag will override this default

  entry: './src/extension.ts', // the entry point of this extension, 📖 -> https://webpack.js.org/configuration/entry-context/
  output: {
    // the bundle is stored in the 'dist' folder (check package.json), 📖 -> https://webpack.js.org/configuration/output/
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2'
  },
  externals: {
    vscode: 'commonjs vscode', // the vscode-module is created on-the-fly and must be excluded. Add other modules that cannot be webpack'ed, 📖 -> https://webpack.js.org/configuration/externals/
    // modules added here also need to be added in the .vscodeignore file
    'bufferutil': 'commonjs bufferutil', // optional dependency
    'utf-8-validate': 'commonjs utf-8-validate', // optional dependency
    'ws': 'commonjs ws', // WebSocket library - must not be bundled to prevent WebSocket masking issues
    'chrome-remote-interface': 'commonjs chrome-remote-interface' // CDP client - must not be bundled to prevent WebSocket masking issues
  },
  resolve: {
    // support reading TypeScript and JavaScript files, 📖 -> https://github.com/TypeStrong/ts-loader
    extensions: ['.ts', '.js'],
    extensionAlias: {
      '.js': ['.js', '.ts'],
      '.mjs': ['.mjs', '.mts', '.ts'],
      '.cjs': ['.cjs', '.cts', '.ts']
    }
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: [
          /node_modules/,
          /\.test\.ts$/,
          /\.spec\.ts$/,
          /__tests__/,
          /src\/__tests__/,
          /src\/.*\/__tests__/
        ],
        use: [
          {
            loader: 'ts-loader'
          }
        ]
      }
    ]
  },
  plugins: [
    // CRITICAL: This plugin must be FIRST to inject module resolution code at the very beginning
    new ModuleResolverPlugin(),
    new CopyWebpackPlugin({
      patterns: [
        {
          from: path.resolve(__dirname, 'src', 'agent', 'prompts', '**', '*.md'),
          to: path.resolve(__dirname, 'dist', 'prompts', '[path][name][ext]'),
          context: path.resolve(__dirname, 'src', 'agent', 'prompts'),
          noErrorOnMissing: true
        },
        {
          from: path.resolve(__dirname, 'src', 'webview', '*.{js,css,html}'),
          to: path.resolve(__dirname, 'dist', 'webview', '[name][ext]'),
          noErrorOnMissing: true
        },
        {
          from: path.resolve(__dirname, 'src', 'webview', '*.{js,css,html}'),
          to: path.resolve(__dirname, 'out', 'webview', '[name][ext]'),
          noErrorOnMissing: true
        }
      ]
    }),
    new HtmlWebpackPlugin({
      filename: 'dist/chat.html',
      template: path.resolve(__dirname, 'src', 'webview', 'chat.html'),
      chunks: ['chat']
    }),
    new HtmlWebpackPlugin({
      filename: 'out/webview/chat.html',
      template: path.resolve(__dirname, 'src', 'webview', 'chat.html'),
      chunks: ['chat']
    })
  ],
    // Disable source maps in production, enable for development
    // Command line --devtool flag will override this
    devtool: isProduction ? false : 'source-map',
    infrastructureLogging: {
      level: "log", // enables logging required for problem matchers
    },
  };
  
  return [ extensionConfig ];
};