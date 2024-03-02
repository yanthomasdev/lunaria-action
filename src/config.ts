import { LunariaConfigSchema } from "@lunariajs/core/config";
import mm from "micromatch";
import type { z } from "zod";

export const scopedConfigSchema = LunariaConfigSchema.pick({
  files: true,
  defaultLocale: true,
  locales: true,
  repository: true,
  ignoreKeywords: true,
});

export function findFileConfig(
  filename: string,
  files: LunariaScopedConfig["files"]
) {
  return files.find(
    (file) =>
      mm.isMatch(filename, file.location) &&
      ["node_modules", ...(file.ignore || [])].every(
        (ignored) => !mm.isMatch(filename, ignored)
      )
  );
}

export type LunariaScopedConfig = z.output<typeof scopedConfigSchema>;
