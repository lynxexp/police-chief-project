/**
 * Ports cogs/pimp_my_bot_preview.py's ThemePreviewView -- 5 sample embeds
 * (Settings Menu, Alliance Changes, Gift Code Status, Member Info,
 * Player Lookup) built from theme data, demonstrating how the current
 * icon/divider/color choices render in real bot contexts. Pure string
 * templating against already-loaded theme data, zero Discord API calls
 * in the source -- same here, this runs entirely client-side against
 * the theme editor's current draft state.
 *
 * Per the plan doc's "Stage 2F builds it, Stage 2G/8 reuse it" note,
 * this renders through the shared <DiscordEmbedPreview> component
 * (components/DiscordEmbedPreview.tsx), extended with `fields` support
 * for these pages.
 */
import type { EmbedPreviewData } from "../components/DiscordEmbedPreview";

const DEFAULT_EMOJI = "👻";

type ThemeData = Record<string, string | number | null | undefined>;

/** Mirrors ThemePreviewView._get_icon() exactly: falls back to the
 * default emoji for a missing, null, or whitespace-only value. */
export function getIcon(data: ThemeData, key: string): string {
  const value = data[key];
  if (value === null || value === undefined || !String(value).trim()) return DEFAULT_EMOJI;
  return String(value);
}

/** Mirrors ThemePreviewView._get_color() -- the source's own
 * `color_str.lstrip('#')` would raise (uncaught) AttributeError on a
 * null color field rather than falling back; that's not worth
 * reproducing for a cosmetic preview, so null/non-string is treated the
 * same as "missing" here instead of crashing the page. */
export function getColor(data: ThemeData, key = "emColorString1"): number {
  const raw = data[key];
  const colorStr = typeof raw === "string" && raw ? raw : "#3498DB";
  const parsed = parseInt(colorStr.replace(/^#+/, ""), 16);
  return Number.isNaN(parsed) ? 0x3498db : parsed;
}

/** Mirrors build_divider() in cogs/pimp_my_bot.py exactly, including
 * its asymmetric fallback: an empty/missing start or end becomes "",
 * but an empty/missing pattern becomes "━" (not blank) so the divider
 * never collapses to nothing. */
export function buildDivider(
  start: string | number | null | undefined,
  pattern: string | number | null | undefined,
  end: string | number | null | undefined,
  length: number,
  maxLength = 99,
): string {
  const clampedLength = Math.min(length, maxLength);
  const startStr = start ? String(start) : "";
  const endStr = end ? String(end) : "";
  const patternStr = pattern ? String(pattern) : "━";

  const patternSpace = clampedLength - startStr.length - endStr.length;
  if (patternSpace <= 0) return (startStr + endStr).slice(0, clampedLength);

  const repeatsNeeded = Math.floor(patternSpace / patternStr.length) + 1;
  const middle = patternStr.repeat(repeatsNeeded).slice(0, patternSpace);
  return startStr + middle + endStr;
}

/** Mirrors ThemePreviewView._get_dividers() -- builds all 3 configured
 * dividers, wrapping in backticks (code block) where enabled. */
export function getDividers(data: ThemeData): [string, string, string] {
  const one = (n: 1 | 2 | 3): string => {
    const rawLength = data[`dividerLength${n}`];
    const length = (typeof rawLength === "number" ? rawLength : Number(rawLength)) || 20;
    let d = buildDivider(data[`dividerStart${n}`], data[`dividerPattern${n}`], data[`dividerEnd${n}`], length);
    if (data[`dividerCodeBlock${n}`]) d = `\`${d}\``;
    return d;
  };
  return [one(1), one(2), one(3)];
}

export const PREVIEW_PAGE_TITLES = [
  "Settings Menu",
  "Alliance Changes",
  "Gift Code Status",
  "Member Info",
  "Player Lookup (/w)",
] as const;

function buildSettingsMenuPreview(data: ThemeData): EmbedPreviewData {
  const [divider1, divider2] = getDividers(data);
  const icon = (key: string) => getIcon(data, key);
  return {
    title: `${icon("settingsIcon")} Settings Menu`,
    description:
      `Please select a category:\n\n` +
      `**Menu Categories**\n${divider1}\n` +
      `${icon("allianceIcon")} **Alliance Operations**\n└ Manage alliances and settings\n\n` +
      `${icon("membersIcon")} **Member Operations**\n└ Add, remove, transfer members\n\n` +
      `${icon("robotIcon")} **Bot Operations**\n└ Configure bot behavior\n\n` +
      `${icon("giftIcon")} **Gift Code Operations**\n└ Redeem and manage gift codes\n\n` +
      `${icon("listIcon")} **Alliance History**\n└ View alliance changes and history\n\n` +
      `${icon("supportIcon")} **Support Operations**\n└ Get help and support\n\n` +
      `${icon("paletteIcon")} **Theme Settings**\n└ Customize bot appearance\n${divider2}`,
    color: getColor(data),
  };
}

function buildChangesPreview(data: ThemeData): EmbedPreviewData {
  const [divider1, divider2] = getDividers(data);
  const icon = (key: string) => getIcon(data, key);
  const user = icon("userIcon");
  const time = icon("timeIcon");
  return {
    title: `${icon("levelIcon")} Alliance Changes`,
    description: `**Recent Member Changes**\n${divider1}\n`,
    color: getColor(data),
    fields: [
      {
        name: `${user} FrostWarrior`,
        value: `${icon("stoveOldIcon")} \`Lv. 5\` ➜ ${icon("stoveIcon")} \`Lv. 6\`\n${time} Just now`,
      },
      {
        name: `${user} IceQueen`,
        value: `${icon("avatarOldIcon")} \`OldNickname\` ➜ ${icon("avatarIcon")} \`IceQueen\`\n${time} 5 min ago`,
      },
      {
        name: `${user} Wanderer`,
        value: `${icon("stateOldIcon")} State \`123\` ➜ ${icon("stateIcon")} State \`456\`\n${time} 1 hour ago`,
      },
      { name: divider2, value: `${icon("chartIcon")} **Total Changes:** 3` },
    ],
  };
}

function buildGiftStatusPreview(data: ThemeData): EmbedPreviewData {
  const [divider1, divider2] = getDividers(data);
  const icon = (key: string) => getIcon(data, key);
  return {
    title: `${icon("giftCheckIcon")} Gift Code Redemption Complete`,
    description:
      `${icon("allianceIcon")} **Alliance:** Really Cool Alliance\n` +
      `${icon("giftIcon")} **Code:** \`WINTERGIFT2024\`\n${divider1}\n` +
      `${icon("verifiedIcon")} **Success:** 45 members\n` +
      `${icon("deniedIcon")} **Already Claimed:** 3 members\n` +
      `${icon("warnIcon")} **Invalid/Error:** 2 members\n${divider2}\n` +
      `${icon("totalIcon")} **Total Processed:** 50 members\n` +
      `${icon("timeIcon")} **Duration:** 2m 34s\n`,
    // Success color -- emColorString3, matching the source's color_key override.
    color: getColor(data, "emColorString3"),
  };
}

function buildMemberInfoPreview(data: ThemeData): EmbedPreviewData {
  const [divider1, divider2] = getDividers(data);
  const icon = (key: string) => getIcon(data, key);
  return {
    title: `${icon("avatarIcon")} Player Profile`,
    description:
      `${divider1}\n` +
      `${icon("fidIcon")} **ID:** \`123456789\`\n` +
      `${icon("avatarIcon")} **Nickname:** FrostWarrior\n` +
      `${icon("allianceIcon")} **Alliance:** Really Cool Alliance\n` +
      `${icon("stoveIcon")} **Chief's Office:** Lv. 8\n` +
      `${icon("stateIcon")} **State:** 999\n` +
      `${icon("crownIcon")} **Rank:** R4\n${divider2}\n` +
      `${icon("verifiedIcon")} **Status:** Verified Member\n` +
      `${icon("homeIcon")} **Joined:** 2024-01-15\n` +
      `${icon("timeIcon")} **Last Active:** Just now\n`,
    color: getColor(data),
    thumbnailUrl: "https://cdn.discordapp.com/embed/avatars/0.png",
  };
}

function buildPlayerLookupPreview(data: ThemeData): EmbedPreviewData {
  const [divider1, divider2, divider3] = getDividers(data);
  const icon = (key: string) => getIcon(data, key);
  return {
    title: `${icon("userIcon")} FrostWarrior`,
    description:
      `${divider1}\n` +
      `**${icon("fidIcon")} ID:** \`123456789\`\n` +
      `**${icon("levelIcon")} Chief's Office Level:** \`Lv. 12\`\n` +
      `**${icon("globeIcon")} State:** \`999\`\n${divider3}\n` +
      `**${icon("allianceIcon")} Alliance:** \`Example Alliance\`\n${divider2}\n`,
    color: getColor(data),
    footer: `Registered on the List ${icon("verifiedIcon")}`,
    imageUrl: "https://cdn.discordapp.com/embed/avatars/1.png",
    thumbnailUrl: "https://cdn.discordapp.com/embed/avatars/2.png",
  };
}

const BUILDERS = [
  buildSettingsMenuPreview,
  buildChangesPreview,
  buildGiftStatusPreview,
  buildMemberInfoPreview,
  buildPlayerLookupPreview,
];

export function buildThemePreview(pageIndex: number, data: ThemeData): EmbedPreviewData {
  return BUILDERS[pageIndex]!(data);
}
