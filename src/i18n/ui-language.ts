export type InterfaceLanguage = "uk" | "en" | "ru";

export const INTERFACE_LANGUAGE_OPTIONS: ReadonlyArray<{
  id: InterfaceLanguage;
  shortLabel: string;
  label: string;
}> = [
  { id: "uk", shortLabel: "UA", label: "Українська" },
  { id: "en", shortLabel: "EN", label: "English" },
  { id: "ru", shortLabel: "RU", label: "Русский" },
];

export const INTERFACE_LOCALES: Record<InterfaceLanguage, string> = {
  uk: "uk-UA",
  en: "en-US",
  ru: "ru-RU",
};

export function detectSystemInterfaceLanguage(): InterfaceLanguage {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase();
    if (locale === "uk" || locale.startsWith("uk-")) return "uk";
    if (locale === "ru" || locale.startsWith("ru-")) return "ru";
  } catch {
    // Hermes normally provides Intl. Fall back to English if locale detection is unavailable.
  }
  return "en";
}

export function normalizeInterfaceLanguage(
  value: unknown,
  fallback: InterfaceLanguage = detectSystemInterfaceLanguage()
): InterfaceLanguage {
  return value === "uk" || value === "en" || value === "ru" ? value : fallback;
}

export function getInterfaceLocale(language: InterfaceLanguage): string {
  return INTERFACE_LOCALES[language];
}
