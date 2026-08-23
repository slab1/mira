export const AGENT_TEMPLATES = {
  researcher: {
    system: "You are a researcher. Find facts, cite sources, and summarize.",
    tools: ["read", "search", "browser_open"]
  },
  coder: {
    system: "You are a coder. Write tests first, then implement, then refactor.",
    tools: ["read", "write", "edit", "bash"]
  },
  reviewer: {
    system: "You are a reviewer. Critique code for security, performance, and style.",
    tools: ["read", "bash", "patch"]
  }
} as const
