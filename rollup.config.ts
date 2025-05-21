// See: https://rollupjs.org/introduction/

import commonjs from '@rollup/plugin-commonjs'
import nodeResolve from '@rollup/plugin-node-resolve'
import typescript from '@rollup/plugin-typescript'

const config = {
  input: {
    index: 'src/index.ts',
    main: 'src/main.ts',
    github: 'src/github.ts',
    version: 'src/version.ts',
    types: 'src/types.ts'
  },
  output: {
    esModule: true,
    dir: 'dist',
    format: 'es',
    sourcemap: true,
    preserveModules: true
  },
  external: [
    '@actions/core',
    '@actions/github',
    '@octokit/rest',
    'semver',
    '@iarna/toml',
    'tslib'
  ],
  plugins: [
    typescript({
      tsconfig: 'tsconfig.build.json',
      sourceMap: true
    }),
    nodeResolve({
      preferBuiltins: true,
      extensions: ['.ts', '.js']
    }),
    commonjs()
  ]
}

export default config
