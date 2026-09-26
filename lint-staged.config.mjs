const config = {
  '*.{js,mjs,ts,tsx}': ['oxfmt --write', 'oxlint --fix'],
  '*.{json,md}': ['oxfmt --write'],
};

export default config;
