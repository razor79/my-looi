import type { ListeningLanguage } from "../language/listening-language";
import type { DrivingCommand } from "./driving-command";

export type DrivingGrammarBundle = {
  phrases: string[];
  commandByPhrase: Map<string, DrivingCommand>;
};

function normalizePhrase(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:()\[\]{}"“”'`~]+/gu, " ")
    .replace(/[\-–—]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function addPhrase(
  map: Map<string, DrivingCommand>,
  phrase: string,
  command: DrivingCommand
): void {
  const normalized = normalizePhrase(phrase);
  if (!normalized || map.has(normalized)) return;
  map.set(normalized, command);
}

function addNaturalVariants(
  map: Map<string, DrivingCommand>,
  command: DrivingCommand,
  bases: string[],
  prefixes: string[],
  suffixes: string[]
): void {
  for (const base of bases) {
    addPhrase(map, base, command);
    for (const prefix of prefixes) addPhrase(map, `${prefix} ${base}`, command);
    for (const suffix of suffixes) addPhrase(map, `${base} ${suffix}`, command);
    // A smaller cross-product covers the very natural "давай X пожалуйста"
    // shape without exploding the graph with every possible filler combination.
    for (const prefix of prefixes.slice(0, 5)) {
      for (const suffix of suffixes.slice(0, 2)) {
        addPhrase(map, `${prefix} ${base} ${suffix}`, command);
      }
    }
  }
}

const STOP_ALL_LANGUAGES = [
  "стоп", "стой", "остановись", "останови", "останови движение", "тормози", "замри", "хватит", "достаточно", "прекрати", "прекрати движение", "не едь", "не езди",
  "стій", "зупинись", "зупини", "зупини рух", "гальмуй", "завмри", "досить", "припини", "припини рух", "не їдь",
  "stop", "halt", "freeze", "brake", "hold", "enough", "stop moving", "stop now", "don't move", "do not move",
];

export function buildDrivingCommandGrammar(language: ListeningLanguage): DrivingGrammarBundle {
  const commandByPhrase = new Map<string, DrivingCommand>();

  // Safety words are intentionally multilingual at all times.
  for (const phrase of STOP_ALL_LANGUAGES) addPhrase(commandByPhrase, phrase, { kind: "stop" });

  if (language === "ru") {
    const prefixes = [
      "давай", "ну давай", "ну", "теперь", "а теперь", "теперь давай", "а теперь давай",
      "давай ка", "ну ка", "ладно", "хорошо", "окей", "робот", "робот давай", "робот теперь",
      "луи", "луи давай", "луи теперь", "макс", "макс давай", "макс теперь", "луй", "уй", "пожалуйста", "давай пожалуйста", "эй робот",
    ];
    const suffixes = ["пожалуйста", "сейчас", "быстро"];

    addNaturalVariants(commandByPhrase, { kind: "stop" }, [
      "стоп", "стой", "остановись", "останови", "останови движение", "тормози", "замри", "хватит", "достаточно", "прекрати", "прекрати движение", "не едь", "не езди",
    ], prefixes, suffixes);
    addNaturalVariants(commandByPhrase, { kind: "move", direction: "forward" }, [
      "вперед", "вперёд", "прямо", "едь вперед", "едь вперёд", "езжай вперед", "езжай вперёд", "поезжай вперед", "поезжай вперёд", "двигайся вперед", "двигайся вперёд", "поехали вперед", "поехали вперёд", "едь прямо", "езжай прямо", "продолжай вперед", "продолжай вперёд", "двигай вперед", "двигай вперёд",
    ], prefixes, suffixes);
    addNaturalVariants(commandByPhrase, { kind: "move", direction: "backward" }, [
      "назад", "обратно", "едь назад", "езжай назад", "поезжай назад", "двигайся назад", "двигай назад", "поехали назад", "едь обратно", "езжай обратно", "поезжай обратно", "сдай назад", "сдавай назад", "двигайся обратно", "отъедь назад", "отъезжай назад",
    ], prefixes, suffixes);
    addNaturalVariants(commandByPhrase, { kind: "turn", direction: "left", degrees: 90 }, [
      "влево", "налево", "лево", "поворот налево", "поворот влево", "поверни налево", "поверни влево", "повернись налево", "повернись влево", "поворачивай налево", "поворачивай влево", "крути налево", "крути влево", "сверни налево", "сверни влево", "развернись налево", "развернись влево",
    ], prefixes, suffixes);
    addNaturalVariants(commandByPhrase, { kind: "turn", direction: "right", degrees: 90 }, [
      "вправо", "направо", "право", "поворот направо", "поворот вправо", "поверни направо", "поверни вправо", "повернись направо", "повернись вправо", "поворачивай направо", "поворачивай вправо", "крути направо", "крути вправо", "сверни направо", "сверни вправо", "развернись направо", "развернись вправо",
    ], prefixes, suffixes);
    addNaturalVariants(commandByPhrase, { kind: "turn", direction: "right", degrees: 180 }, [
      "развернись", "разверни", "разворот", "сделай разворот", "сделай полный разворот", "развернись назад", "повернись назад", "кругом", "на сто восемьдесят", "поверни на сто восемьдесят", "развернись на сто восемьдесят", "сделай сто восемьдесят",
    ], prefixes, suffixes);
    addNaturalVariants(commandByPhrase, { kind: "gesture", gesture: "nod", count: 1 }, [
      "кивни", "кивни головой", "подтверди", "подтверди головой", "скажи да головой", "сделай кивок", "один кивок",
    ], prefixes, suffixes);
    addNaturalVariants(commandByPhrase, { kind: "gesture", gesture: "nod", count: 2 }, [
      "кивни два раза", "дважды кивни", "два кивка", "сделай два кивка",
    ], prefixes, suffixes);
    addNaturalVariants(commandByPhrase, { kind: "gesture", gesture: "nod", count: 3 }, [
      "кивни три раза", "трижды кивни", "три кивка", "сделай три кивка",
    ], prefixes, suffixes);
    addNaturalVariants(commandByPhrase, { kind: "gesture", gesture: "happy_bob", count: 1 }, [
      "покачай головой", "помаши головой", "покивай головой", "подвигай головой",
    ], prefixes, suffixes);
    addNaturalVariants(commandByPhrase, { kind: "dance" }, [
      "танцуй", "потанцуй", "станцуй", "станцуй мне", "покажи танец", "сделай танец", "покрутись", "покружись", "давай танцевать",
    ], prefixes, suffixes);
    addNaturalVariants(commandByPhrase, { kind: "sleep" }, [
      "спи", "засни", "усни", "иди спать", "ложись спать", "пора спать",
    ], prefixes, suffixes);
    addNaturalVariants(commandByPhrase, { kind: "light", enabled: true }, [
      "включи свет", "свет включи", "зажги свет", "включи подсветку", "зажги подсветку",
    ], prefixes, suffixes);
    addNaturalVariants(commandByPhrase, { kind: "light", enabled: false }, [
      "выключи свет", "свет выключи", "погаси свет", "выключи подсветку", "погаси подсветку",
    ], prefixes, suffixes);
    addNaturalVariants(commandByPhrase, { kind: "exit" }, [
      "закончили", "всё закончили", "все закончили", "хватит управлять", "обычный режим", "поговорим", "давай поговорим", "вернись к разговору", "режим разговора",
    ], ["", "ну", "давай"], ["", "пожалуйста"]);
  } else if (language === "uk") {
    const prefixes = [
      "давай", "ну давай", "ну", "тепер", "а тепер", "тепер давай", "а тепер давай",
      "ну ж бо", "гаразд", "добре", "окей", "робот", "робот давай", "робот тепер",
      "луї", "луї давай", "луї тепер", "макс", "макс давай", "макс тепер", "луі", "будь ласка", "давай будь ласка", "ей робот",
    ];
    const suffixes = ["будь ласка", "зараз", "швидко"];

    addNaturalVariants(commandByPhrase, { kind: "stop" }, [
      "стоп", "стій", "зупинись", "зупини", "зупини рух", "гальмуй", "завмри", "досить", "припини", "припини рух", "не їдь",
    ], prefixes, suffixes);
    addNaturalVariants(commandByPhrase, { kind: "move", direction: "forward" }, [
      "вперед", "прямо", "їдь вперед", "їдь прямо", "їдь уперед", "поїдь вперед", "поїдь уперед", "рухайся вперед", "рухайся уперед", "поїхали вперед", "поїхали уперед", "продовжуй вперед", "продовжуй уперед",
    ], prefixes, suffixes);
    addNaturalVariants(commandByPhrase, { kind: "move", direction: "backward" }, [
      "назад", "обратно", "їдь назад", "поїдь назад", "рухайся назад", "поїхали назад", "здай назад", "здавай назад", "від'їдь назад", "від'їжджай назад",
    ], prefixes, suffixes);
    addNaturalVariants(commandByPhrase, { kind: "turn", direction: "left", degrees: 90 }, [
      "вліво", "наліво", "ліворуч", "поворот наліво", "поворот вліво", "поверни наліво", "поверни вліво", "повернись наліво", "повернись вліво", "повертай наліво", "повертай вліво", "крути наліво", "крути вліво", "зверни наліво", "зверни вліво",
    ], prefixes, suffixes);
    addNaturalVariants(commandByPhrase, { kind: "turn", direction: "right", degrees: 90 }, [
      "вправо", "направо", "праворуч", "поворот направо", "поворот вправо", "поверни направо", "поверни вправо", "повернись направо", "повернись вправо", "повертай направо", "повертай вправо", "крути направо", "крути вправо", "зверни направо", "зверни вправо",
    ], prefixes, suffixes);
    addNaturalVariants(commandByPhrase, { kind: "turn", direction: "right", degrees: 180 }, [
      "розвернись", "розверни", "розворот", "зроби розворот", "зроби повний розворот", "розвернись назад", "повернись назад", "кругом", "на сто вісімдесят", "поверни на сто вісімдесят", "розвернись на сто вісімдесят",
    ], prefixes, suffixes);
    addNaturalVariants(commandByPhrase, { kind: "gesture", gesture: "nod", count: 1 }, [
      "кивни", "кивни головою", "підтверди", "підтверди головою", "скажи так головою", "зроби кивок",
    ], prefixes, suffixes);
    addNaturalVariants(commandByPhrase, { kind: "gesture", gesture: "nod", count: 2 }, [
      "кивни два рази", "двічі кивни", "два кивки", "зроби два кивки",
    ], prefixes, suffixes);
    addNaturalVariants(commandByPhrase, { kind: "gesture", gesture: "nod", count: 3 }, [
      "кивни три рази", "тричі кивни", "три кивки", "зроби три кивки",
    ], prefixes, suffixes);
    addNaturalVariants(commandByPhrase, { kind: "gesture", gesture: "happy_bob", count: 1 }, [
      "похитай головою", "помахай головою", "покивай головою", "порухай головою",
    ], prefixes, suffixes);
    addNaturalVariants(commandByPhrase, { kind: "dance" }, [
      "танцюй", "потанцюй", "станцюй", "станцюй мені", "покажи танець", "зроби танець", "покрутись", "покружляй", "давай танцювати",
    ], prefixes, suffixes);
    addNaturalVariants(commandByPhrase, { kind: "sleep" }, [
      "спи", "засни", "засинай", "іди спати", "лягай спати", "час спати",
    ], prefixes, suffixes);
    addNaturalVariants(commandByPhrase, { kind: "light", enabled: true }, [
      "увімкни світло", "включи світло", "світло увімкни", "запали світло", "увімкни підсвітку",
    ], prefixes, suffixes);
    addNaturalVariants(commandByPhrase, { kind: "light", enabled: false }, [
      "вимкни світло", "світло вимкни", "погаси світло", "вимкни підсвітку",
    ], prefixes, suffixes);
    addNaturalVariants(commandByPhrase, { kind: "exit" }, [
      "закінчили", "все закінчили", "досить керувати", "звичайний режим", "поговорімо", "давай поговоримо", "повернись до розмови", "режим розмови",
    ], ["", "ну", "давай"], ["", "будь ласка"]);
  } else {
    const prefixes = [
      "go", "please", "okay", "ok", "well", "now", "now please", "and now", "now let's",
      "let's", "come on", "alright", "robot", "robot please", "robot now", "looi", "looi please", "max", "max please", "max now",
      "looi now", "hey robot",
    ];
    const suffixes = ["please", "now", "quickly"];

    addNaturalVariants(commandByPhrase, { kind: "stop" }, [
      "stop", "halt", "freeze", "brake", "hold", "enough", "stop moving", "stop now", "don't move", "do not move",
    ], prefixes, suffixes);
    addNaturalVariants(commandByPhrase, { kind: "move", direction: "forward" }, [
      "forward", "ahead", "straight", "go forward", "go ahead", "drive forward", "move forward", "keep going forward", "go straight", "drive straight", "move straight",
    ], prefixes, suffixes);
    addNaturalVariants(commandByPhrase, { kind: "move", direction: "backward" }, [
      "back", "backward", "go back", "go backward", "drive back", "drive backward", "move back", "move backward", "reverse", "back up", "go in reverse",
    ], prefixes, suffixes);
    addNaturalVariants(commandByPhrase, { kind: "turn", direction: "left", degrees: 90 }, [
      "left", "turn left", "go left", "rotate left", "pivot left", "make a left turn", "turn to the left", "spin left",
    ], prefixes, suffixes);
    addNaturalVariants(commandByPhrase, { kind: "turn", direction: "right", degrees: 90 }, [
      "right", "turn right", "go right", "rotate right", "pivot right", "make a right turn", "turn to the right", "spin right",
    ], prefixes, suffixes);
    addNaturalVariants(commandByPhrase, { kind: "turn", direction: "right", degrees: 180 }, [
      "turn around", "u turn", "make a u turn", "one eighty", "turn one eighty", "turn 180 degrees", "rotate one eighty", "face the other way", "turn back around",
    ], prefixes, suffixes);
    addNaturalVariants(commandByPhrase, { kind: "gesture", gesture: "nod", count: 1 }, [
      "nod", "nod your head", "confirm", "confirm with your head", "say yes with your head", "one nod",
    ], prefixes, suffixes);
    addNaturalVariants(commandByPhrase, { kind: "gesture", gesture: "nod", count: 2 }, [
      "nod twice", "nod two times", "two nods", "give me two nods",
    ], prefixes, suffixes);
    addNaturalVariants(commandByPhrase, { kind: "gesture", gesture: "nod", count: 3 }, [
      "nod three times", "three nods", "give me three nods",
    ], prefixes, suffixes);
    addNaturalVariants(commandByPhrase, { kind: "gesture", gesture: "happy_bob", count: 1 }, [
      "bob your head", "wave your head", "move your head", "happy head bob",
    ], prefixes, suffixes);
    addNaturalVariants(commandByPhrase, { kind: "dance" }, [
      "dance", "do a dance", "dance for me", "show me a dance", "spin and dance", "do your dance",
    ], prefixes, suffixes);
    addNaturalVariants(commandByPhrase, { kind: "sleep" }, [
      "sleep", "go to sleep", "fall asleep", "time to sleep", "go to bed",
    ], prefixes, suffixes);
    addNaturalVariants(commandByPhrase, { kind: "light", enabled: true }, [
      "lights on", "light on", "turn on the light", "turn the light on", "switch on the light",
    ], prefixes, suffixes);
    addNaturalVariants(commandByPhrase, { kind: "light", enabled: false }, [
      "lights off", "light off", "turn off the light", "turn the light off", "switch off the light",
    ], prefixes, suffixes);
    addNaturalVariants(commandByPhrase, { kind: "exit" }, [
      "done", "finish driving", "stop driving", "normal mode", "conversation mode", "let's talk", "back to conversation", "exit driving mode",
    ], ["", "okay", "please"], ["", "please"]);
  }

  const phrases = Array.from(commandByPhrase.keys());
  phrases.push("[unk]");
  return { phrases, commandByPhrase };
}

export function normalizeDrivingGrammarResult(text: string): string {
  return normalizePhrase(text);
}
