export default {
  rules: {
    'scope-enum': [
      2,
      'always',
      ['release', 'ci', 'github', 'deps', 'deps-dev']
    ],
    'type-enum': [
      2,
      'always',
      [
        'chore',
        'ci',
        'docs',
        'feat',
        'fix',
        'perf',
        'refactor',
        'revert',
        'test',
        'chore-docs'
      ]
    ]
  },
  extends: ['@commitlint/config-conventional']
}
