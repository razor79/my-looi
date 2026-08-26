const MAX_QUERY_TOKENS = 16;

// Generic high-frequency function words only. This list never maps a user
// question to a particular memory domain (name, food, family, etc.). Its sole
// purpose is to keep the lexical fallback from being dominated by grammar.
const MEMORY_SEARCH_STOPWORDS = new Set([
  // RU
  "а", "и", "или", "как", "какой", "какая", "какое", "какие", "у", "я", "мне", "меня",
  "мой", "моя", "моё", "мое", "мои", "мою", "моего", "моей", "моему", "моим", "моих",
  "ты", "вы", "это", "что", "кто", "где", "когда", "ли", "же", "бы", "про", "о", "об",
  // UK
  "та", "і", "або", "як", "який", "яка", "яке", "які", "у", "я", "мені", "мене", "мій",
  "моя", "моє", "мої", "мою", "мого", "моєї", "моєму", "моїм", "моїх",
  "ти", "ви", "це", "що", "хто", "де", "коли", "чи", "про",
  // EN
  "a", "an", "the", "is", "are", "am", "i", "me", "my", "mine", "you", "your", "what",
  "which", "who", "where", "when", "how", "do", "does", "did", "about", "of", "to",
]);

export function normalizeMemorySearchText(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[’'`]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildMemoryFtsQuery(query: string): string | null {
  const tokens = [...new Set(
    normalizeMemorySearchText(query)
      .split(" ")
      .filter((token) => token.length >= 2 && !MEMORY_SEARCH_STOPWORDS.has(token))
  )].slice(0, MAX_QUERY_TOKENS);
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(" OR ");
}
function relaxedStem(token: string): string | null {
  if (token.length < 5) return null;
  // A conservative prefix fallback handles common inflection drift without
  // pretending to be a semantic model. Cyrillic words need four letters for
  // cases such as "любимые" -> "любит"; Latin words keep five to avoid
  // excessively broad matches.
  const hasCyrillic = /[\u0400-\u04FF]/u.test(token);
  const length = hasCyrillic ? 4 : 5;
  if (token.length <= length) return null;
  return token.slice(0, length);
}

export function buildRelaxedMemoryFtsQuery(query: string): string | null {
  const tokens = [...new Set(
    normalizeMemorySearchText(query)
      .split(" ")
      .filter((token) => token.length >= 2 && !MEMORY_SEARCH_STOPWORDS.has(token))
  )].slice(0, MAX_QUERY_TOKENS);
  if (tokens.length === 0) return null;

  const terms: string[] = [];
  for (const token of tokens) {
    terms.push(`"${token.replace(/"/g, '""')}"*`);
    const stem = relaxedStem(token);
    if (stem && stem !== token) terms.push(`"${stem.replace(/"/g, '""')}"*`);
  }
  return [...new Set(terms)].join(" OR ");
}

