/* Webpack config for VS Code extension (Node target) */
// @ts-check
const path = require('path');

/**
 * @type {import('webpack').Configuration}
 */
const config = {
  target: 'node',
  mode: 'none', // set via CLI: production/development
  entry: './src/extension.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2',
    devtoolModuleFilenameTemplate: '../[resource-path]'
  },
  devtool: 'source-map',
  externals: {
    // the vscode-module is created on-the-fly and must be excluded
    vscode: 'commonjs vscode'
  },
  resolve: {
    extensions: ['.ts', '.js']
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader',
            options: {
              configFile: 'tsconfig.extension.json',
              transpileOnly: true
            }
          }
        ]
      }
    ]
  },
  infrastructureLogging: {
    level: 'warn'
  }
};

module.exports = config;

