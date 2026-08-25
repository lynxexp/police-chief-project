/**
 * Ported verbatim from cogs/pimp_my_bot.py's ICON_CATEGORIES dict --
 * groups the ~150 icon fields on pimpsettings for the editor UI. The
 * flattened ICON_COLUMNS list doubles as the SQL-injection-safety
 * allowlist for PATCH /admin/themes/:themeName (mirrors
 * pimp_my_bot_editor.py's own use of ICON_NAMES for exactly that).
 *
 * "Other" is NOT from the Python source -- 10 real columns
 * (foundryIcon, crazyJoeIcon, frostdragonIcon, canyonClashIcon,
 * castleBattleIcon, fortressBattleIcon, frostfireMineIcon, svsIcon,
 * mercenaryIcon, dailyResetIcon) exist on the table and clearly belong
 * to game features added after pimp_my_bot.py's categorization dict was
 * last updated, but aren't in ICON_CATEGORIES at all -- meaning the
 * bot's own Discord theme editor can't touch them either (it iterates
 * ICON_CATEGORIES, not the raw schema). Confirmed via PRAGMA table_info
 * against the live schema, not guessed. Bucketing them here gives the
 * web editor more complete coverage than Discord currently has, which
 * seems like a reasonable bonus rather than a deviation worth avoiding.
 */
export const ICON_CATEGORIES: Record<string, string[]> = {
  Status: [
    "verifiedIcon", "deniedIcon", "warnIcon", "infoIcon", "questionIcon", "checkIcon",
    "processingIcon", "blankListIcon", "circleIcon",
  ],
  Navigation: [
    "homeIcon", "backIcon", "prevIcon", "nextIcon", "forwardIcon",
    "upIcon", "downIcon", "num1Icon", "num2Icon", "num3Icon",
    "num4Icon", "num5Icon", "num10Icon",
  ],
  Actions: [
    "addIcon", "minusIcon", "trashIcon", "editListIcon", "settingsIcon",
    "saveIcon", "refreshIcon", "eyeIcon", "eyesIcon", "searchIcon", "listIcon",
    "lockIcon", "linkIcon", "copyIcon", "retryIcon", "deleteIcon", "redeemIcon",
    "multiplyIcon", "divideIcon", "magnifyingIcon",
  ],
  Display: [
    "userIcon", "fidIcon", "timeIcon", "calendarIcon", "levelIcon",
    "globeIcon", "membersIcon", "crownIcon", "totalIcon", "pinIcon",
    "averageIcon", "chartIcon", "documentIcon", "newIcon", "locationIcon",
    "fireIcon", "messageNoIcon",
  ],
  Operations: [
    "shieldIcon", "crossIcon",
    "importIcon", "exportIcon", "transferIcon",
    "giftIcon", "giftsIcon", "ticketIcon", "packageIcon", "targetIcon",
    "giftAddIcon", "giftAlarmIcon", "gifAlertIcon", "giftCheckIcon",
    "giftTotalIcon", "giftDeleteIcon", "giftHashtagIcon", "giftSettingsIcon",
  ],
  "Alliance History": [
    "allianceOldIcon", "allianceIcon", "avatarOldIcon", "avatarIcon",
    "stoveOldIcon", "stoveIcon", "stateOldIcon", "stateIcon", "chiefOfficeIcon",
  ],
  Notifications: [
    "announceIcon", "wizardIcon", "alarmClockIcon", "hourglassIcon", "bellIcon", "muteIcon",
  ],
  Events: ["vaultTrapIcon"],
  "Shift Scheduling": [
    "ministerIcon", "constructionIcon", "researchIcon", "trainingIcon",
    "archiveIcon", "medalIcon",
  ],
  "Bot Management": [
    "robotIcon", "supportIcon", "chatIcon", "boltIcon", "testIcon",
    "cleanIcon", "paletteIcon", "starIcon", "heartIcon", "messageIcon",
    "shutdownZzzIcon", "shutdownDoorIcon", "shutdownHandIcon", "shutdownMoonIcon",
    "shutdownPlugIcon", "shutdownStopIcon", "shutdownClapperIcon", "shutdownSparkleIcon",
    "startupGiftIcon", "startupBoxingIcon", "startupRocketIcon", "startupLockIcon",
    "startupFireIcon", "startupSwordsIcon", "startupIceIcon", "startupCashIcon",
  ],
  Other: [
    "foundryIcon", "crazyJoeIcon", "frostdragonIcon", "canyonClashIcon",
    "castleBattleIcon", "fortressBattleIcon", "frostfireMineIcon", "svsIcon",
    "mercenaryIcon", "dailyResetIcon",
  ],
};

export const ICON_COLUMNS: string[] = Object.values(ICON_CATEGORIES).flat();

export const DIVIDER_FIELDS = ["Start", "Pattern", "End", "Length", "CodeBlock"] as const;
export const DIVIDER_INDICES = [1, 2, 3] as const;
export const DIVIDER_COLUMNS: string[] = DIVIDER_INDICES.flatMap((i) =>
  DIVIDER_FIELDS.map((f) => `divider${f}${i}`),
);
export const COLOR_COLUMNS = [
  "emColorString1", "emColorString2", "emColorString3", "emColorString4",
  "headerColor1", "headerColor2",
];

/** Every field PATCH /admin/themes/:themeName is allowed to touch --
 * icons + dividers + colors + description. NOT id/themeName/themeCreator/
 * is_active/createdAt/created_guild_id, which have their own dedicated
 * mutation paths (rename, set-active, etc). Building an UPDATE from
 * arbitrary request-body keys without this allowlist would be a SQL
 * injection risk via column names -- same reasoning
 * pimp_my_bot_editor.py's own ICON_NAMES whitelist exists for. */
export const EDITABLE_THEME_COLUMNS = new Set<string>([
  ...ICON_COLUMNS,
  ...DIVIDER_COLUMNS,
  ...COLOR_COLUMNS,
  "themeDescription",
]);
