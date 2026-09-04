const config = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      [
        "feat", "fix", "refactor", "perf", "test", "docs",
        "build", "chore", "style", "revert", "ci", "init",
      ],
    ],
    "scope-enum": [
      1,
      "always",
      [
        "server", "web", "tui", "cli", "shared", "slack",
        "vscode", "deps", "ci", "dx", "eval", "gateway",
        "memory", "auth", "guardrails", "lsp", "mcp",
      ],
    ],
    "subject-case": [2, "never", ["start-case", "pascal-case", "upper-case"]],
    "header-max-length": [2, "always", 72],
    "body-max-line-length": [1, "always", 100],
  },
};

export default config;
