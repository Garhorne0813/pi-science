let content: Promise<typeof import("./SettingsContent")> | null = null;

export function loadSettingsContent() {
  return content ??= import("./SettingsContent").catch((error) => { content = null; throw error; });
}

/** Warm only the Settings shell and General on pointer/keyboard intent. */
export function preloadSettingsContent() { void loadSettingsContent().catch(() => undefined); }
