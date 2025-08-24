import React from 'react';

export function SpinnerIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" fill="none" />
      <path d="M12 3 A9 9 0 0 1 21 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none">
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 12 12"
          to="360 12 12"
          dur="1s"
          repeatCount="indefinite"
        />
      </path>
    </svg>
  );
}

export function ReplayIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d="M20 8h-2.81a5.978 5.978 0 00-1.9-1.99l1.39-1.39-1.41-1.41-1.76 1.76A5.963 5.963 0 0012 4c-.5 0-.98.06-1.44.18L8.8 2.42 7.39 3.83l1.39 1.39A5.978 5.978 0 006 8H4v2h2.09c.13 .7 .39 1.36 .76 1.95L5.5 15.3l1.41 1.41 1.4-1.4c.59 .37 1.25 .63 1.95 .76V20h2v-2.93c.7 -.13 1.36 -.39 1.95 -.76l1.4 1.4 1.41 -1.41 -1.35 -1.35c.37 -.59 .63 -1.25 .76 -1.95H20V8zm-8 6a4 4 0 110 -8 4 4 0 010 8z" />
    </svg>
  );
}
