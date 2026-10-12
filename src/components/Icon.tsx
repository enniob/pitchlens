/** One consistent set of 24 px stroke icons. Always decorative: the control that uses one carries the label. */
const PATHS = {
  play: "M7 5v14l12-7z",
  pause: "M8.5 5v14M15.5 5v14",
  restart: "M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4",
  prev: "M18 6l-8 6 8 6zM6 6v12",
  next: "M6 6l8 6-8 6zM18 6v12",
  close: "M6 6l12 12M18 6L6 18",
  setup: "M4 7h10M18 7h2M4 17h2M10 17h10M16 5v4M8 15v4",
  lock: "M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5zM12 14v3",
  list: "M4 5h16M4 12h16M4 19h10",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
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
  check: "M5 12.5l4.5 4.5L19 7",
  spark: "M11 3l1.9 5.6L18.5 10.5l-5.6 1.9L11 18l-1.9-5.6L3.5 10.5l5.6-1.9zM18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z",
  flask: "M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3M7.5 14h9",
  pulse: "M3 12h4l2.5-6 5 12 2.5-6h4",
  users: "M9 11a3.5 3.5 0 1 0 0-7a3.5 3.5 0 1 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.3a3.5 3.5 0 0 1 0 6.4M18 14.2a6.5 6.5 0 0 1 3.5 5.8",
  bars: "M5 20V11M12 20V5M19 20v-6M3 20h18",
  target: "M12 3a9 9 0 1 0 9 9M12 7.5a4.5 4.5 0 1 0 4.5 4.5M12 12l8-8M16.5 4v3.5H20",
  nodes: "M6 8a2.5 2.5 0 1 0 0-5a2.5 2.5 0 1 0 0 5zM18 11.5a2.5 2.5 0 1 0 0-5a2.5 2.5 0 1 0 0 5zM8 21a2.5 2.5 0 1 0 0-5a2.5 2.5 0 1 0 0 5zM7.5 7.5l8.3 1.6M7 16.2l-.6-8.2M9.8 16.9l6.7-6",
  fullscreen: "M4 9V4h5M4 4l6 6M20 9V4h-5M20 4l-6 6M4 15v5h5M4 20l6-6M20 15v5h-5M20 20l-6-6",
  arrow: "M4 12h15M13 6l6 6-6 6",
  chat: "M4 5h16v11H9l-5 4z",
  /** PitchLens brand mark: a lens ring around a focus ring, with sight ticks. */
  lens: "M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 1 0 0-17zM12 8.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7zM12 1v3M12 20v3M1 12h3M20 12h3M7.6 7.1a6 6 0 0 1 2.4-1.3",
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
