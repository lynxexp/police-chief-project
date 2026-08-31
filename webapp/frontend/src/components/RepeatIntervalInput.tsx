import { minutesToUnits, unitsToMinutes, type RepeatIntervalUnits } from "../notifications/repeatInterval";

const UNIT_FIELDS: { key: keyof RepeatIntervalUnits; label: string }[] = [
  { key: "months", label: "Months" },
  { key: "weeks", label: "Weeks" },
  { key: "days", label: "Days" },
  { key: "hours", label: "Hours" },
  { key: "minutes", label: "Minutes" },
];

/** Months/weeks/days/hours/minutes picker mirroring the bot's own
 * "Custom Interval" modal (notification_system.py's RepeatIntervalModal)
 * -- avoids making admins hand-compute e.g. 2880 for "every other day". */
export default function RepeatIntervalInput({
  totalMinutes,
  onChange,
}: {
  totalMinutes: number;
  onChange: (totalMinutes: number) => void;
}) {
  const units = minutesToUnits(totalMinutes);

  const setUnit = (key: keyof RepeatIntervalUnits, value: number) => {
    onChange(unitsToMinutes({ ...units, [key]: Math.max(0, Math.floor(value) || 0) }));
  };

  return (
    <div className="mt-2 grid grid-cols-5 gap-2">
      {UNIT_FIELDS.map((f) => (
        <div key={f.key}>
          <label className="mb-1 block text-[11px] text-ink-faint">
            {f.label}
            <input
              type="number"
              min={0}
              value={units[f.key]}
              onChange={(e) => setUnit(f.key, Number(e.target.value))}
              className="mt-1 w-full rounded-control border border-line bg-surface-sunken px-2 py-1 text-sm text-ink"
            />
          </label>
        </div>
      ))}
    </div>
  );
}
