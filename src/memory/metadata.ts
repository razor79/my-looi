import { KnownMemoryCategory, MemoryCategory, ObservationSource } from "../core/observation";

export interface MemoryMetadata {
  category: MemoryCategory;
  timestamp: string;
  source: ObservationSource;
  evidenceUri?: string;
}

/**
 * Classify the content into a memory category based on keywords
 */
export function classifyCategory(content: string): KnownMemoryCategory {
  const lower = content.toLowerCase();

  // Placement indicators
  const placementKeywords = [
    "положил", "положила", "оставил", "оставила", "лежит", "стоит", "находится",
    "поклав", "поклала", "залишив", "залишила", "лежить", "стоїть", "знаходиться",
    "put", "placed", "left", "lies", "located",
  ];
  if (placementKeywords.some((kw) => lower.includes(kw))) {
    return "placement";
  }

  // Preference indicators
  const preferenceKeywords = [
    "нравится", "не нравится", "предпочитаю", "привык",
    "подобається", "не подобається", "віддаю перевагу", "звик",
    "like", "dislike", "prefer", "usually",
  ];
  if (preferenceKeywords.some((kw) => lower.includes(kw))) {
    return "preference";
  }

  // Reminder indicators
  const reminderKeywords = [
    "напомни", "не забудь", "в следующий раз",
    "нагадай", "не забудь", "наступного разу",
    "remind", "don't forget", "next time",
  ];
  if (reminderKeywords.some((kw) => lower.includes(kw))) {
    return "reminder";
  }

  // Calendar indicators
  const calendarKeywords = [
    "встреча", "совещание", "календарь", "событие",
    "зустріч", "нарада", "календар", "подія",
    "meeting", "appointment", "calendar", "event",
  ];
  if (calendarKeywords.some((kw) => lower.includes(kw))) {
    return "calendar";
  }

  return "note";
}

/**
 * Detect whether content contains spatial reference words
 * that should trigger camera capture
 */
export function hasVisualReference(content: string): boolean {
  const lower = content.toLowerCase();
  const visualKeywords = [
    "вот это", "здесь", "тут", "там", "положил сюда", "посмотри",
    "ось це", "тут", "там", "поклав сюди", "подивись",
    "this", "here", "there", "put it here", "look at",
  ];
  return visualKeywords.some((kw) => lower.includes(kw));
}

/**
 * Build metadata for a new memory entry
 */
export function buildMemoryMetadata(
  content: string,
  source: ObservationSource,
  evidenceUri?: string
): MemoryMetadata {
  return {
    category: classifyCategory(content),
    timestamp: new Date().toISOString(),
    source,
    evidenceUri,
  };
}
