import { useMemo } from "react";
import { useUserStore } from "@/src/store/user";
import { createUiTranslator } from "./ui-strings";
import { getInterfaceLocale } from "./ui-language";

export function useUiText() {
  const language = useUserStore((state) => state.preferences.interfaceLanguage);
  const t = useMemo(() => createUiTranslator(language), [language]);
  return { language, locale: getInterfaceLocale(language), t };
}
