const js = require("@eslint/js");

module.exports = [
  {
    ignores: ["node_modules/", "data/", "dist/", ".claude/"]
  },
  {
    files: ["src/**/*.js", "tests/**/*.js"],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: "commonjs",
      globals: {
        // Node.js globals
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        clearInterval: "readonly",
        clearTimeout: "readonly",
        console: "readonly",
        global: "readonly",
        process: "readonly",
        setInterval: "readonly",
        setTimeout: "readonly",
        // Global APIs
        URLSearchParams: "readonly",
        fetch: "readonly",
        // Test globals
        before: "readonly",
        beforeEach: "readonly",
        after: "readonly",
        afterEach: "readonly",
        describe: "readonly",
        it: "readonly",
        test: "readonly",
        expect: "readonly",
        assert: "readonly"
      }
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-console": ["warn"],
      "no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_"
        }
      ],
      "no-trailing-spaces": "warn",
      "eqeqeq": ["warn", "always"],
      "no-var": "warn",
      "prefer-const": "warn",
      "no-empty": ["warn", { allowEmptyCatch: true }]
    }
  },
  {
    files: ["src/cli.js", "src/cli-validate.js", "src/prune.js", "src/export.js", "src/db/migrate.js"],
    rules: {
      "no-console": "off"
    }
  }
];
