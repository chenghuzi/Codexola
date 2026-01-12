export type PromptInvocation = {
  name: string;
  args: string[];
  vars: Record<string, string>;
  rawArgs: string;
};

const PROMPT_PREFIX = "/prompts:";

export function parsePromptInvocation(input: string): PromptInvocation | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith(PROMPT_PREFIX)) {
    return null;
  }
  const rest = trimmed.slice(PROMPT_PREFIX.length);
  if (!rest) {
    return null;
  }
  const tokens = tokenizeArgs(rest);
  const name = tokens.shift()?.trim() ?? "";
  if (!name) {
    return null;
  }
  const rawArgs = tokens.join(" ").trim();
  const vars: Record<string, string> = {};
  const args: string[] = [];
  tokens.forEach((token) => {
    const eqIndex = token.indexOf("=");
    if (eqIndex > 0) {
      const key = token.slice(0, eqIndex).trim();
      const value = token.slice(eqIndex + 1).trim();
      if (key) {
        vars[key] = value;
        return;
      }
    }
    if (token) {
      args.push(token);
    }
  });
  return {
    name,
    args,
    vars,
    rawArgs,
  };
}

export function expandPromptTemplate(
  template: string,
  invocation: PromptInvocation,
): string {
  const sentinel = "__CODEX_PROMPT_DOLLAR__";
  let output = template.replace(/\$\$/g, sentinel);
  output = output.replace(/\$ARGUMENTS\b/g, invocation.args.join(" "));
  output = output.replace(/\$(\d)\b/g, (_match, digit) => {
    const index = Number(digit) - 1;
    if (Number.isNaN(index) || index < 0) {
      return "";
    }
    return invocation.args[index] ?? "";
  });
  Object.entries(invocation.vars).forEach(([key, value]) => {
    if (!key) {
      return;
    }
    const pattern = new RegExp(`\\$${escapeRegExp(key)}\\b`, "g");
    output = output.replace(pattern, value);
  });
  return output.replace(new RegExp(sentinel, "g"), "$");
}

function tokenizeArgs(input: string): string[] {
  if (!input.trim()) {
    return [];
  }
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escape = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (escape) {
      current += char;
      escape = false;
      continue;
    }
    if (char === "\\") {
      escape = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
