import type { CustomVoiceCommandAction, CustomVoiceCommandMap, CustomVoiceCommandPhrase, VoiceCommandLanguage } from "../store/user";
export type ExplicitRobotCommand =
  | { kind: "move"; direction: "forward" | "backward" | "stop" }
  | { kind: "turn"; direction: "left" | "right"; degrees: 90 | 180 }
  | { kind: "sleep" }
  | { kind: "dance" }
  | { kind: "gesture"; gesture: "nod"; count: number };

export type ExplicitRobotCommandConfig = {
  robotName?: string;
  robotAddressAliases?: readonly string[];
  robotAddressRecognitionAliases?: readonly string[];
  listeningLanguage?: VoiceCommandLanguage;
  customVoiceCommands?: CustomVoiceCommandMap;
};

// Narrow STT recovery aliases are accepted only in the address position and
// still require the remainder to parse as a deterministic physical command.
const BUILTIN_ADDRESS_ALIASES = ["луи", "луй", "луни", "луї", "луі", "лу и", "looi", "макс", "max", "робот", "robot", "уи", "уй", "рога"];

function normalizeMatchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/ё/g, "е").replace(/[’'`]/g, "").replace(/[^a-zа-яіїєґ0-9\s]/giu, " ").replace(/\s+/g, " ").trim();
}

function configuredAddresses(config?: ExplicitRobotCommandConfig): string[] {
  return [config?.robotName ?? "Луи", ...(config?.robotAddressAliases ?? []), ...(config?.robotAddressRecognitionAliases ?? []), ...BUILTIN_ADDRESS_ALIASES]
    .map(normalizeMatchText).filter(Boolean).sort((a, b) => b.length - a.length);
}

function splitAddressedCommand(text: string, config?: ExplicitRobotCommandConfig): { address: string; command: string } | null {
  const normalized = normalizeMatchText(normalizeKnownGluedRobotAddress(text));
  for (const address of configuredAddresses(config)) {
    if (normalized === address) return null;
    if (normalized.startsWith(`${address} `)) return { address, command: normalized.slice(address.length).trim() };
  }
  return null;
}

export function hasExplicitRobotAddress(text: string, config?: ExplicitRobotCommandConfig): boolean {
  return splitAddressedCommand(text, config) !== null;
}

const MOVE_VERB_RE = /(?:^|\s)(?:едь|езжай|поедь|проедь|двигайся|двинься|повернись|поверни|їдь|поїдь|рухайся|повернись|поверни|go|drive|move|turn)(?=$|[\s.,!?])/iu;

function isBareDirectionCommand(command: string, variants: string): boolean {
  return new RegExp(`^(?:${variants})(?:\\s+(?:пожалуйста|немного|чуть(?:-чуть)?))?[.!?]*$`, "i").test(command.trim());
}

/** Standalone built-in STOP is an absolute safety keyword and never requires an address. */
export function containsEmergencyStopWord(text: string, config?: ExplicitRobotCommandConfig): boolean {
  const normalized = normalizeMatchText(text);
  if (/(?:^|\s)(?:стоп|stop)(?=$|\s)/iu.test(normalized)) return true;
  const listeningLanguage = config?.listeningLanguage ?? "ru";
  return (config?.customVoiceCommands?.emergency_stop ?? []).some((phrase) => phrase.language === listeningLanguage && phraseMatches(normalized, phrase));
}

function phraseMatches(normalizedCommand: string, phrase: CustomVoiceCommandPhrase): boolean {
  return normalizedCommand === normalizeMatchText(phrase.text);
}

function customActionFor(command: string, config?: ExplicitRobotCommandConfig): CustomVoiceCommandAction | null {
  const listeningLanguage = config?.listeningLanguage ?? "ru";
  const entries = Object.entries(config?.customVoiceCommands ?? {}) as Array<[CustomVoiceCommandAction, CustomVoiceCommandPhrase[]]>;

  // Prefer the phrase language matching the active Listening language. This is
  // the normal path and keeps multilingual aliases predictable.
  for (const [action, phrases] of entries) {
    if (action === "emergency_stop") continue;
    if (phrases.some((phrase) => phrase.language === listeningLanguage && phraseMatches(command, phrase))) return action;
  }

  // If the listening language changed after the user created a phrase, an exact
  // addressed custom phrase should still work when it maps unambiguously to one
  // action. Never guess when the same text is configured for different actions.
  const matchingActions = entries
    .filter(([action, phrases]) => action !== "emergency_stop" && phrases.some((phrase) => phraseMatches(command, phrase)))
    .map(([action]) => action);
  return new Set(matchingActions).size === 1 ? matchingActions[0] ?? null : null;
}

function commandFromCustomAction(action: CustomVoiceCommandAction, command: string): ExplicitRobotCommand | null {
  switch (action) {
    case "forward": return { kind: "move", direction: "forward" };
    case "backward": return { kind: "move", direction: "backward" };
    case "left": return { kind: "turn", direction: "left", degrees: 90 };
    case "right": return { kind: "turn", direction: "right", degrees: 90 };
    case "turn_around": return { kind: "turn", direction: "right", degrees: 180 };
    case "nod": return { kind: "gesture", gesture: "nod", count: parseRequestedNodCount(command) };
    case "dance": return { kind: "dance" };
    case "sleep": return { kind: "sleep" };
    default: return null;
  }
}

/**
 * Parse deterministic physical commands. Wheel movement/sleep still require an
 * explicit address at utterance start. STOP is additionally handled by the
 * global emergency path before this parser.
 */
function normalizeKnownGluedRobotAddress(text: string): string {
  // Whisper occasionally joins the wake address to a short deterministic command
  // (for example "Луикивни три раза"). Only split known physical-command stems so
  // arbitrary conversational words beginning with "луи" are not broadened.
  return text.trim().replace(
    /^(луи|луй|луни|луї|луі|макс|max|робот|robot|уи|уй|рога)(?=(?:кивни|кивай|стоп|стой|спи|засни|потанцуй|потанцюй|танцуй|танцюй|dance|впер[её]д|назад|влево|вправо|налево|направо|развернись))/iu,
    "$1 "
  );
}


function stripNaturalCommandLeadIns(command: string): string {
  let value = command.trim();
  // Address-at-start remains mandatory. These fillers are accepted only AFTER
  // a valid "Луи/Робот" address so natural forms like "Робот, давай назад"
  // remain deterministic physical commands rather than broad conversation.
  const leadIn = /^(?:(?:ну\s+)?давай(?:-ка)?|ну-ка|теперь|а\s+теперь|ладно|хорошо|окей|пожалуйста)\s+/iu;
  for (let i = 0; i < 3; i += 1) {
    const next = value.replace(leadIn, "");
    if (next === value) break;
    value = next.trim();
  }
  return value;
}

export function parseExplicitRobotCommand(text: string, config?: ExplicitRobotCommandConfig): ExplicitRobotCommand | null {
  const addressed = splitAddressedCommand(text, config);
  if (!addressed) return null;

  const command = stripNaturalCommandLeadIns(addressed.command.trim().toLowerCase());
  const customAction = customActionFor(command, config);
  if (customAction) return commandFromCustomAction(customAction, command);

  if (/(?:^|\s)(?:спи|спать|засни|засыпай|иди\s+спать|ложись\s+спать|засинай|спати|іди\s+спати|sleep|go\s+to\s+sleep|fall\s+asleep)(?=$|[\s.,!?])/iu.test(command)) {
    return { kind: "sleep" };
  }

  if (/(?:^|\s)(?:кивни|кивай|сделай\s+кивок|підтверди|зроби\s+кивок|nod|nod\s+your\s+head|confirm)(?=$|[\s.,!?])/iu.test(command)) {
    return { kind: "gesture", gesture: "nod", count: parseRequestedNodCount(command) };
  }

  if (/(?:^|\s)(?:потанцуй|станцуй|танцуй|потанцюй|станцюй|танцюй|dance|do\s+a\s+dance)(?=$|[\s.,!?])/iu.test(command)) {
    return { kind: "dance" };
  }

  if (/(?:^|\s)(?:стоп|стой|остановись|останови\s+движение|стій|зупинись|зупини|stop|halt)(?=$|[\s.,!?])/iu.test(command)) {
    return { kind: "move", direction: "stop" };
  }

  if (
    /(?:^|\s)(?:развернись|разверни|повернись\s+обратно|поверни\s+обратно|розвернись|розверни|повернись\s+назад|turn\s+around|make\s+a\s+u\s*turn|u\s*turn)(?=$|[\s.,!?])/iu.test(command) ||
    /(?:^|\s)(?:180|сто\s+восемьдесят|сто\s+вісімдесят|one\s+eighty)\s*(?:градус(?:ов|а)?|градус(?:ів|и)?|degrees?|°)?(?=$|[\s.,!?])/iu.test(command)
  ) {
    // Clockwise/right is the deterministic default for a 180° turn.
    return { kind: "turn", direction: "right", degrees: 180 };
  }

  const hasMoveVerb = MOVE_VERB_RE.test(command);

  if (
    (hasMoveVerb && /(?:^|\s)(?:впер[её]д|вперед|прямо|forward|ahead|straight)(?=$|[\s.,!?])/iu.test(command)) ||
    isBareDirectionCommand(command, "впер[её]д|вперед|прямо|forward|ahead|straight")
  ) {
    return { kind: "move", direction: "forward" };
  }
  if (
    (hasMoveVerb && /(?:^|\s)(?:назад|обратно|back|backward|reverse)(?=$|[\s.,!?])/iu.test(command)) ||
    isBareDirectionCommand(command, "назад|обратно|back|backward|reverse")
  ) {
    return { kind: "move", direction: "backward" };
  }
  if (
    (hasMoveVerb && /(?:^|\s)(?:влево|налево|левее|вліво|наліво|ліворуч|left)(?=$|[\s.,!?])/iu.test(command)) ||
    isBareDirectionCommand(command, "влево|налево|левее|вліво|наліво|ліворуч|left")
  ) {
    return { kind: "turn", direction: "left", degrees: 90 };
  }
  if (
    (hasMoveVerb && /(?:^|\s)(?:вправо|направо|правее|праворуч|right)(?=$|[\s.,!?])/iu.test(command)) ||
    isBareDirectionCommand(command, "вправо|направо|правее|праворуч|right")
  ) {
    return { kind: "turn", direction: "right", degrees: 90 };
  }

  return null;
}

function parseRequestedNodCount(command: string): number {
  const digit = /(?:^|\s)([1-5])\s*(?:раз(?:а)?|разок)?(?=$|[\s.,!?])/i.exec(command);
  if (digit) return Number(digit[1]);

  const wordCounts: Array<[RegExp, number]> = [
    [/(?:^|\s)(?:пять|пятикратно)(?=\s|$|[.,!?])/i, 5],
    [/(?:^|\s)(?:четыре|четырежды)(?=\s|$|[.,!?])/i, 4],
    [/(?:^|\s)(?:три|трижды)(?=\s|$|[.,!?])/i, 3],
    [/(?:^|\s)(?:два|две|дважды)(?=\s|$|[.,!?])/i, 2],
    [/(?:^|\s)(?:один|одна|один раз)(?=\s|$|[.,!?])/i, 1],
  ];
  for (const [pattern, count] of wordCounts) {
    if (pattern.test(command)) return count;
  }
  return 1;
}
