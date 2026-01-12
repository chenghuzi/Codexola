import type { PromptOption, SlashItem } from "../types";

export function buildPromptSlashItems(prompts: PromptOption[]): SlashItem[] {
  return prompts
    .filter((prompt) => prompt.name)
    .map((prompt) => ({
      id: `prompt:${prompt.name}`,
      kind: "prompt",
      title: prompt.name,
      description: prompt.description,
      hint: prompt.argumentHint,
      insertText: `/prompts:${prompt.name} `,
    }));
}

export function filterSlashItems(items: SlashItem[], query: string): SlashItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return items;
  }
  return items
    .filter((item) => {
      if (item.title.toLowerCase().includes(needle)) {
        return true;
      }
      if (item.description && item.description.toLowerCase().includes(needle)) {
        return true;
      }
      return false;
    })
    .sort((a, b) => {
      const aStarts = a.title.toLowerCase().startsWith(needle);
      const bStarts = b.title.toLowerCase().startsWith(needle);
      if (aStarts && !bStarts) {
        return -1;
      }
      if (!aStarts && bStarts) {
        return 1;
      }
      return a.title.localeCompare(b.title);
    });
}
