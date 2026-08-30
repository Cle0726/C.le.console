import { getBeijingCalendarFields } from '../utils/beijingTime';

/**
 * Opening sequence copy.
 *
 * Kept separate from the component so lines can be added or reworded without
 * touching any logic. Everything below is data: add a string to an array and it
 * enters the rotation on the next launch.
 *
 * Three things fight stiffness here. The day is cut into seven bands instead of
 * five, so 5am and 10am no longer share a line. Each band holds several
 * phrasings that are picked at random, so the same hour does not produce the
 * same screen twice running. And the closing note is drawn from a pool that
 * shifts with the day — late nights, Mondays, Fridays and weekends each get
 * lines the other days never see.
 *
 * Tone: plain and unhurried. Nothing motivational-poster, nothing exclamatory.
 * The English line is a companion, not a translation — it carries the same mood
 * in fewer words.
 */

export interface GreetingCopy {
  zh: string;
  en: string;
  note: string;
}

interface Band {
  /** Inclusive start hour, exclusive end hour. */
  from: number;
  to: number;
  lines: Array<Pick<GreetingCopy, 'zh' | 'en'>>;
}

const BANDS: Band[] = [
  {
    from: 0,
    to: 5,
    lines: [
      { zh: '夜深了，才酷。', en: 'THE QUIET HOURS.' },
      { zh: '才酷，还没睡吗？', en: 'STILL UP?' },
      { zh: '已经凌晨了，才酷。', en: 'LATE ONE TONIGHT.' },
      { zh: '凌晨好，才酷。', en: 'NIGHT SHIFT.' },
      { zh: '才酷，还在忙吗？', en: 'SMALL HOURS.' },
    ],
  },
  {
    from: 5,
    to: 8,
    lines: [
      { zh: '早，才酷。', en: 'EARLY START.' },
      { zh: '天刚亮，才酷。', en: 'FIRST LIGHT.' },
      { zh: '才酷，今天起得真早。', en: 'UP BEFORE THE CITY.' },
      { zh: '清晨好，才酷。', en: 'MORNING, ALREADY.' },
      { zh: '这么早就开始了，才酷。', en: 'QUIET START.' },
    ],
  },
  {
    from: 8,
    to: 11,
    lines: [
      { zh: '早上好，才酷。', en: 'GOOD MORNING.' },
      { zh: '上午好，才酷。', en: 'A FRESH ONE.' },
      { zh: '新的一天开始了，才酷。', en: 'MORNING, PROPERLY.' },
      { zh: '才酷，开工吧。', en: "LET'S BEGIN." },
      { zh: '早安，才酷。', en: 'NEW DAY.' },
    ],
  },
  {
    from: 11,
    to: 14,
    lines: [
      { zh: '中午好，才酷。', en: 'MIDDAY.' },
      { zh: '才酷，该吃饭了。', en: 'LUNCH SOON?' },
      { zh: '半天过去了，才酷。', en: 'HALF A DAY IN.' },
      { zh: '午间好，才酷。', en: 'NOON.' },
      { zh: '才酷，先歇一会儿吧。', en: 'TAKE A BREATH.' },
    ],
  },
  {
    from: 14,
    to: 18,
    lines: [
      { zh: '下午好，才酷。', en: 'GOOD AFTERNOON.' },
      { zh: '已经下午了，才酷。', en: 'AFTERNOON.' },
      { zh: '今天过半了，才酷。', en: 'PAST THE HALFWAY MARK.' },
      { zh: '午后好，才酷。', en: 'SECOND HALF.' },
      { zh: '才酷，我们继续。', en: 'CARRYING ON.' },
    ],
  },
  {
    from: 18,
    to: 21,
    lines: [
      { zh: '晚上好，才酷。', en: 'GOOD EVENING.' },
      { zh: '天黑了，才酷。', en: 'LIGHTS ON.' },
      { zh: '傍晚好，才酷。', en: 'EVENING.' },
      { zh: '才酷，准备收工了吗？', en: 'WRAPPING UP?' },
      { zh: '入夜了，才酷。', en: 'DUSK.' },
    ],
  },
  {
    from: 21,
    to: 24,
    lines: [
      { zh: '晚上好，才酷。', en: 'LATE EVENING.' },
      { zh: '夜里好，才酷。', en: 'STILL GOING.' },
      { zh: '才酷，还在忙吗？', en: 'WINDING DOWN?' },
      { zh: '已经很晚了，才酷。', en: 'GETTING LATE.' },
      { zh: '夜深了，才酷。', en: 'NIGHT.' },
    ],
  },
];

/** Always available. */
const NOTES_ANY = [
  '不用赶，一件一件来。',
  '先把眼前这一件做好。',
  '手边这件做完，其他的稍后再说。',
  '慢一点也没关系。',
  '先做简单的，状态会慢慢回来。',
  '今天不必把所有事情都做完。',
  '一次专心处理一件事。',
  '有些问题放一会儿，反而会更清楚。',
  '做完这一件，记得歇一会儿。',
  '窗口少开几个，思路会轻一点。',
  '眼睛累了，就看看远处。',
  '喝口水，再继续。',
  '把要做的写下来，脑子会轻一点。',
  '先开始，再慢慢调整。',
];

const NOTES_LATE = [
  '别在深夜做重要决定。',
  '早点睡，明天更划算。',
  '这个点的想法，天亮再看一遍。',
  '再撑一会儿就去休息。',
  '夜里的难题，白天常常自己就解了。',
];

const NOTES_MONDAY = [
  '周一慢慢启动就好。',
  '开头难，先做最容易的那件。',
  '一周才刚开始，别一次用完力气。',
];

const NOTES_FRIDAY = [
  '收个尾，剩下的下周再说。',
  '把没做完的记下来，然后关掉。',
  '这周辛苦了。',
];

const NOTES_WEEKEND = [
  '周末也可以什么都不做。',
  '今天不欠任何人进度。',
  '想做就做一点，不想就算了。',
];

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function resolveBand(hour: number): Band {
  return BANDS.find((band) => hour >= band.from && hour < band.to) ?? BANDS[BANDS.length - 1];
}

function resolveNotePool(now: Date): string[] {
  const { hour, weekday: day } = getBeijingCalendarFields(now);
  const pool = [...NOTES_ANY];

  // Contextual lines are added rather than substituted, so the general pool
  // still shows up and the special ones stay a pleasant surprise.
  if (hour < 5 || hour >= 23) pool.push(...NOTES_LATE, ...NOTES_LATE);
  if (day === 0 || day === 6) pool.push(...NOTES_WEEKEND, ...NOTES_WEEKEND);
  else if (day === 1) pool.push(...NOTES_MONDAY, ...NOTES_MONDAY);
  else if (day === 5) pool.push(...NOTES_FRIDAY, ...NOTES_FRIDAY);

  return pool;
}

export function resolveGreetingCopy(now: Date): GreetingCopy {
  const band = resolveBand(getBeijingCalendarFields(now).hour);
  const line = pick(band.lines);
  return {
    ...line,
    note: pick(resolveNotePool(now)),
  };
}
