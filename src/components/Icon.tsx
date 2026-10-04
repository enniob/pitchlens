/** One consistent set of 24 px stroke icons. Always decorative: the control that uses one carries the label. */
const PATHS = {
  play: "M7 5v14l12-7z",
  pause: "M8.5 5v14M15.5 5v14",
  restart: "M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4",
  prev: "M18 6l-8 6 8 6zM6 6v12",
  next: "M6 6l8 6-8 6zM18 6v12",
  close: "M6 6l12 12M18 6L6 18",
  setup: "M4 7h10M18 7h2M4 17h2M10 17h10M16 5v4M8 15v4",
  list: "M4 5h16M4 12h16M4 19h10",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  fit: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
  chevron: "M6 9l6 6 6-6",
  info: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 11v6M12 7.5v.5",
  warning: "M12 3l9.5 17h-19zM12 10v4M12 17v.5",
  goal: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 8l3.5 2.5-1.3 4h-4.4l-1.3-4z",
  shot: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8z",
  save: "M8 13V6a1.5 1.5 0 0 1 3 0v5M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V6a1.5 1.5 0 0 1 3 0v7a6 6 0 0 1-6 6h-1a5 5 0 0 1-4.3-2.5L4 12a1.5 1.5 0 0 1 2.6-1.5L8 13",
  whistle: "M3 10h11a5 5 0 1 1-4.9 6H6a3 3 0 0 1-3-3zM14 10V6h5",
  flag: "M5 21V4M5 4h11l-2 4 2 4H5",
  swap: "M7 4L3 8l4 4M3 8h14M17 12l4 4-4 4M21 16H7",
  pass: "M4 12h12M12 7l5 5-5 5",
} as const;

export type IconName = keyof typeof PATHS;

const FILLED: readonly IconName[] = ["play"];

export function Icon({ name, size = 20, className }: { name: IconName; size?: number; className?: string }) {
  const filled = FILLED.includes(name);
  return (
    <svg
      className={`icon${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={name === "pause" ? 3 : 2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
