/**
 * VYUHA's own mark: a shield with the tricolour bands and a chevron (the formation the name refers to).
 * It is deliberately not the State Emblem of India, whose use is restricted by law.
 */
export function BrandMark({ className = 'h-12 w-12' }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 56" className={className} role="img" aria-label="VYUHA">
      <path
        d="M24 2 4 9v19c0 13 8.5 22 20 26 11.500-4 20-13 20-26V9z"
        fill="#fff"
        stroke="currentColor"
        strokeWidth="3"
      />
      <clipPath id="vy-shield">
        <path d="M24 5.500 7 11.500v16.500c0 11.500 7.500 19.500 17 23.500C33.500 47.500 41 39.500 41 28V11.500z" />
      </clipPath>
      <g clipPath="url(#vy-shield)">
        <rect x="0" y="0" width="48" height="19" fill="#ff7f00" />
        <rect x="0" y="19" width="48" height="18" fill="#ffffff" />
        <rect x="0" y="37" width="48" height="19" fill="#138808" />
      </g>
      <path
        d="M14 17l10 22 10-22"
        fill="none"
        stroke="#0b2a66"
        strokeWidth="5"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </svg>
  );
}
