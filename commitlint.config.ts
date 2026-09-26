import { RuleConfigSeverity, UserConfig } from '@commitlint/types';

const config = {
  extends: ['@commitlint/config-conventional'],
  plugins: [
    {
      rules: {
        'header-atomic': ({ header }) => {
          const matches = /(?:^|[\s([])(and|&)(?=[\s)\]]|$)/i.exec(header ?? '');

          return [
            !matches,
            `header must not join changes with "${matches?.[0]}" — one logical change per commit`,
          ];
        },
        'header-no-comma': ({ header }) => {
          return [
            !header?.includes(','),
            'header must not contain a comma — split into separate commits instead',
          ];
        },
        'header-lower-case': ({ header }) => {
          return [
            header == null || header === header.toLowerCase(),
            'header must be entirely lowercase',
          ];
        },
      },
    },
  ],
  rules: {
    'subject-min-length': [RuleConfigSeverity.Error, 'always', 10],
    'header-max-length': [RuleConfigSeverity.Error, 'always', 72],
    'header-atomic': [RuleConfigSeverity.Error, 'always'],
    'header-no-comma': [RuleConfigSeverity.Error, 'always'],
    'header-lower-case': [RuleConfigSeverity.Error, 'always'],
    'scope-enum': [
      RuleConfigSeverity.Error,
      'always',
      ['adr', 'agents', 'build', 'cli', 'domain', 'lib', 'license'],
    ],
    'body-max-line-length': [RuleConfigSeverity.Error, 'always', 72],
    'footer-max-line-length': [RuleConfigSeverity.Error, 'always', 72],
  },
} satisfies UserConfig;

export default config;
