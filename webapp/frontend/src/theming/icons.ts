/**
 * Mirrors webapp/backend/src/theming/icons.ts exactly -- see that file's
 * doc comment for where this data comes from (ported from cogs/
 * pimp_my_bot.py's ICON_CATEGORIES, plus a confirmed-real "Other" bucket
 * for 10 columns that exist on the schema but aren't in the Python
 * source's categorization dict). Duplicated rather than shared, same as
 * this codebase's existing Tier type -- there's no shared package
 * between webapp/backend and webapp/frontend.
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

export const DIVIDER_INDICES = [1, 2, 3] as const;
export const COLOR_FIELDS = [
  { key: "emColorString1", label: "Embed color 1" },
  { key: "emColorString2", label: "Embed color 2" },
  { key: "emColorString3", label: "Embed color 3" },
  { key: "emColorString4", label: "Embed color 4" },
  { key: "headerColor1", label: "Header color 1" },
  { key: "headerColor2", label: "Header color 2" },
];
