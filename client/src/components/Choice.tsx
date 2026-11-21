/** Segmented buttons: pick one value. */
interface Props<T extends number | string> {
  id: string;
  label: string;
  options: T[];
  value: T;
  onChange: (value: T) => void;
  format?: (value: T) => string;
}

export function Choice<T extends number | string>({ id, label, options, value, onChange, format = String }: Props<T>) {
  return (
    <div id={id} className="choice" role="group" aria-label={label}>
      {options.map(option => (
        <button key={option} type="button" data-value={option} aria-pressed={option === value} onClick={() => onChange(option)}>
          {format(option)}
        </button>
      ))}
    </div>
  );
}
