import type { ResponseLanguage } from "./response-language";

type VoiceMessageKey =
  | "not-heard"
  | "owner-rejected"
  | "command-missing"
  | "processing-failed";

const VOICE_MESSAGES: Record<
  VoiceMessageKey,
  Record<ResponseLanguage, string>
> = {
  "not-heard": {
    ru: "Я не расслышал. Подойди немного ближе и повтори.",
    uk: "Я не розчув. Підійди трохи ближче й повтори.",
    en: "I didn't catch that. Come a little closer and try again.",
  },
  "owner-rejected": {
    ru: "Голос не прошёл проверку. Запиши ещё один образец голоса в настройках или повтори команду чётче.",
    uk: "Голос не пройшов перевірку. Запиши ще один зразок голосу в налаштуваннях або повтори команду чіткіше.",
    en: "Voice verification failed. Add another voice sample in settings or repeat the command more clearly.",
  },
  "command-missing": {
    ru: "После имени LOOI скажи команду одним предложением.",
    uk: "Після імені LOOI скажи команду одним реченням.",
    en: "After saying LOOI, say your command in one sentence.",
  },
  "processing-failed": {
    ru: "Не получилось обработать запрос. Попробуй ещё раз.",
    uk: "Не вдалося обробити запит. Спробуй ще раз.",
    en: "I couldn't process that request. Please try again.",
  },
};

export function getVoiceResponseMessage(
  language: ResponseLanguage,
  key: VoiceMessageKey
): string {
  return VOICE_MESSAGES[key][language];
}
