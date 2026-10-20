import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentCommandContext, AgentCommandSource } from "./index.ts";
import { ancestorsToRepoRoot, piTemplates, walkSkills } from "./walk.ts";
import type { SlashCommand } from "../../shared/protocol.ts";

const asCommands = (found: ReturnType<typeof walkSkills>, origin: NonNullable<SlashCommand["origin"]>): SlashCommand[] =>
  found.map(({ name, description }) => ({ name: `skill:${name}`, description, source: "skill", origin }));

const recursive = (root: string): ReturnType<typeof walkSkills> => walkSkills(root, { depth: "recursive", looseMarkdown: "root", ignoreFiles: false, requireDescription: true });

function discoverSkills({ home, cwd }: AgentCommandContext): SlashCommand[] {
  const agentDir = join(home, ".commandcode");
  const user = [...recursive(join(agentDir, "skills")), ...recursive(join(home, ".agents", "skills"))];
  const result = asCommands(user, "user");
  if (cwd) {
    for (const directory of ancestorsToRepoRoot(cwd)) {
      const project = [
        ...recursive(join(directory, ".commandcode", "skills")),
        ...recursive(join(directory, ".agents", "skills")),
      ];
      result.push(...asCommands(project, "project"));
    }
  }
  // deduplicate by name, keeping the first (user before project) occurrence
  const seen = new Set<string>();
  return result.filter((cmd) => {
    if (seen.has(cmd.name)) return false;
    seen.add(cmd.name);
    return true;
  });
}

export const source: AgentCommandSource = {
  builtins: [],
  discover(ctx) {
    const { home, cwd } = ctx;
    const agentDir = join(home, ".commandcode");
    const result: SlashCommand[] = [];
    // Command Code stores custom slash commands in commands/, not prompts/
    result.push(...piTemplates(join(agentDir, "commands"), "user"));
    if (cwd && existsSync(join(cwd, ".commandcode", "commands"))) {
      result.push(...piTemplates(join(cwd, ".commandcode", "commands"), "project"));
    }
    result.push(...discoverSkills(ctx));
    return result;
  },
};